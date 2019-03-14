class ParticleSystem {
    constructor(cesiumContext, windData, particleSystemOptions, viewerParameters) {
        this.context = cesiumContext;
        this.data = windData;

        this.particleSystemOptions = particleSystemOptions;
        this.particleSystemOptions.particlesTextureSize = Math.ceil(Math.sqrt(this.particleSystemOptions.maxParticles));
        this.particlesArray = DataProcess.randomizeParticleLonLatLev(this.particleSystemOptions.maxParticles, viewerParameters.lonLatRange);

        this.clearCommand = new Cesium.ClearCommand({
            color: new Cesium.Color(0.0, 0.0, 0.0, 0.0),
            depth: 1.0,
            framebuffer: undefined
        });

        this.uniformVariables = {};
        this.setUnifromValues(viewerParameters.pixelSize);
        this.setupDataTextures();

        this.outputTextures = {};
        this.setupParticlesTextures(this.particlesArray);

        this.framebuffers = {};
        this.setupOutputFramebuffers();

        this.primitives = {};
        this.initComputePrimitive();
        this.initSegmentsPrimitive();
        this.initTrailsPrimitive();
        this.initScreenPrimitive();
    }

    setUnifromValues(pixelSize) {
        this.uniformVariables.lonRange = new Cesium.Cartesian2(0.0, 360.0);
        this.uniformVariables.latRange = new Cesium.Cartesian2(-90.0, 90.0);
        this.uniformVariables.relativeSpeedRange = new Cesium.Cartesian2(
            this.particleSystemOptions.uvMinFactor * pixelSize,
            this.particleSystemOptions.uvMaxFactor * pixelSize
        );
    }

    setupDataTextures() {
        const uvTextureOptions = {
            context: this.context,
            width: this.data.dimensions.lon,
            height: this.data.dimensions.lat * this.data.dimensions.lev,
            pixelFormat: Cesium.PixelFormat.LUMINANCE,
            pixelDatatype: Cesium.PixelDatatype.FLOAT,
            flipY: false, // the data we provide should not be flipped
            sampler: new Cesium.Sampler({
                // the values of data texture should not be interpolated
                minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
                magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST
            })
        };

        this.uniformVariables.U = Util.createTexture(uvTextureOptions, this.data.U.array);
        this.uniformVariables.V = Util.createTexture(uvTextureOptions, this.data.V.array);

        const colorTableTextureOptions = {
            context: this.context,
            width: this.data.colorTable.colorNum,
            height: 1,
            pixelFormat: Cesium.PixelFormat.RGB,
            pixelDatatype: Cesium.PixelDatatype.FLOAT,
            sampler: new Cesium.Sampler({
                minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
                magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR
            })
        }
        this.uniformVariables.colorTable = Util.createTexture(colorTableTextureOptions, this.data.colorTable.array);
    }

    setupParticlesTextures() {
        const particlesTextureOptions = {
            context: this.context,
            width: this.particleSystemOptions.particlesTextureSize,
            height: this.particleSystemOptions.particlesTextureSize,
            pixelFormat: Cesium.PixelFormat.RGB,
            pixelDatatype: Cesium.PixelDatatype.FLOAT,
            sampler: new Cesium.Sampler({
                // the values of particles texture should not be interpolated
                minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
                magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST
            })
        };

        var particlesTexture0 = Util.createTexture(particlesTextureOptions, this.particlesArray);
        var particlesTexture1 = Util.createTexture(particlesTextureOptions, this.particlesArray);

        // used for ping-pong render
        this.outputTextures.fromParticles = particlesTexture0;
        this.outputTextures.toParticles = particlesTexture1;
    }

    setupOutputFramebuffers() {
        const colorTextureOptions = {
            context: this.context,
            width: this.context.drawingBufferWidth,
            height: this.context.drawingBufferHeight,
            pixelFormat: Cesium.PixelFormat.RGBA,
            pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE
        }

        const depthTextureOptions = {
            context: this.context,
            width: this.context.drawingBufferWidth,
            height: this.context.drawingBufferHeight,
            pixelFormat: Cesium.PixelFormat.DEPTH_COMPONENT,
            pixelDatatype: Cesium.PixelDatatype.UNSIGNED_INT
        }

        var segmentsColorTexture = Util.createTexture(colorTextureOptions);
        var segmentsDepthTexture = Util.createTexture(depthTextureOptions);
        this.framebuffers.segments = Util.createFramebuffer(this.context, segmentsColorTexture, segmentsDepthTexture);

        var trailsColorTexture0 = Util.createTexture(colorTextureOptions);
        var trailsDepthTexture0 = Util.createTexture(depthTextureOptions);
        var trailsFramebuffer0 = Util.createFramebuffer(this.context, trailsColorTexture0, trailsDepthTexture0);

        var trailsColorTexture1 = Util.createTexture(colorTextureOptions);
        var trailsDepthTexture1 = Util.createTexture(depthTextureOptions);
        var trailsFramebuffer1 = Util.createFramebuffer(this.context, trailsColorTexture1, trailsDepthTexture1);

        // used for ping-pong render
        this.framebuffers.currentTrails = trailsFramebuffer0;
        this.framebuffers.nextTrails = trailsFramebuffer1;
    }

    initComputePrimitive() {
        const attributeLocations = {
            position: 0,
            st: 1
        };

        const minimum = new Cesium.Cartesian3(this.data.lon.min, this.data.lat.min, this.data.lev.min);
        const maximum = new Cesium.Cartesian3(this.data.lon.max, this.data.lat.max, this.data.lev.max);
        const dimension = new Cesium.Cartesian3(
            this.data.dimensions.lon,
            this.data.dimensions.lat,
            this.data.dimensions.lev
        );
        const interval = new Cesium.Cartesian3(
            (maximum.x - minimum.x) / (dimension.x - 1),
            (maximum.y - minimum.y) / (dimension.y - 1),
            (maximum.z - minimum.z) / (dimension.z - 1)
        );
        const uSpeedRange = new Cesium.Cartesian3(
            this.data.U.min,
            this.data.U.max,
            this.data.U.max - this.data.U.min
        );
        const vSpeedRange = new Cesium.Cartesian3(
            this.data.V.min,
            this.data.V.max,
            this.data.V.max - this.data.V.min
        );

        const that = this;
        const uniformMap = {
            U: function () {
                return that.uniformVariables.U;
            },
            V: function () {
                return that.uniformVariables.V;
            },
            particles: function () {
                return that.outputTextures.fromParticles;
            },
            dimension: function () {
                return dimension;
            },
            minimum: function () {
                return minimum;
            },
            maximum: function () {
                return maximum;
            },
            interval: function () {
                return interval;
            },
            uSpeedRange: function () {
                return uSpeedRange;
            },
            vSpeedRange: function () {
                return vSpeedRange;
            },
            relativeSpeedRange: function () {
                return that.uniformVariables.relativeSpeedRange;
            },
            lonRange: function () {
                return that.uniformVariables.lonRange;
            },
            latRange: function () {
                return that.uniformVariables.latRange;
            },
            dropRate: function () {
                return that.particleSystemOptions.dropRate;
            },
            dropRateBump: function () {
                return that.particleSystemOptions.dropRateBump;
            }
        }

        const rawRenderState = Util.createRawRenderState({
            viewport: new Cesium.BoundingRectangle(0, 0,
                this.particleSystemOptions.particlesTextureSize, this.particleSystemOptions.particlesTextureSize),
            depthTest: {
                enabled: false
            }
        });

        const vertexShaderSource = new Cesium.ShaderSource({
            sources: [Util.loadText('glsl/fullscreen.vert')]
        });

        const fragmentShaderSource = new Cesium.ShaderSource({
            sources: [Util.loadText('glsl/update.frag')]
        });

        this.primitives.compute = new CustomPrimitive({
            commandType: 'Compute',
            geometry: Util.getFullscreenQuad(),
            attributeLocations: attributeLocations,
            primitiveType: Cesium.PrimitiveType.TRIANGLES,
            uniformMap: uniformMap,
            vertexShaderSource: vertexShaderSource,
            fragmentShaderSource: fragmentShaderSource,
            rawRenderState: rawRenderState,
            outputTexture: this.outputTextures.toParticles
        });

        // redefine the preExecute function for ping-pong particles computation
        this.primitives.compute.preExecute = function () {
            // swap framebuffers before binding framebuffer
            var temp;
            temp = that.outputTextures.fromParticles;
            that.outputTextures.fromParticles = that.outputTextures.toParticles;
            that.outputTextures.toParticles = temp;

            this.commandToExecute.outputTexture = that.outputTextures.toParticles;
        }
    }

    initSegmentsPrimitive() {
        var particleIndex = [];

        for (var s = 0; s < this.particleSystemOptions.particlesTextureSize; s++) {
            for (var t = 0; t < this.particleSystemOptions.particlesTextureSize; t++) {
                for (var i = 0; i < 2; i++) {
                    particleIndex.push(s / this.particleSystemOptions.particlesTextureSize);
                    particleIndex.push(t / this.particleSystemOptions.particlesTextureSize);
                    particleIndex.push(i); // use i to distinguish indexes of fromParticles and toParticles
                }
            }
        }
        particleIndex = new Float32Array(particleIndex);

        const particlePoints = new Cesium.Geometry({
            attributes: new Cesium.GeometryAttributes({
                position: new Cesium.GeometryAttribute({
                    componentDatatype: Cesium.ComponentDatatype.FLOAT,
                    componentsPerAttribute: 3,
                    values: particleIndex
                })
            })
        });

        const attributeLocations = {
            position: 0
        };

        const that = this;
        const uniformMap = {
            fromParticles: function () {
                return that.outputTextures.fromParticles;
            },
            toParticles: function () {
                return that.outputTextures.toParticles;
            },
            colorTable: function () {
                return that.uniformVariables.colorTable;
            }
        };

        const rawRenderState = Util.createRawRenderState({
            // undefined value means let Cesium deal with it
            viewport: undefined,
            depthTest: {
                enabled: true
            },
            depthMask: true
        });

        const vertexShaderSource = new Cesium.ShaderSource({
            sources: [Util.loadText('glsl/segmentDraw.vert')]
        });

        const fragmentShaderSource = new Cesium.ShaderSource({
            sources: [Util.loadText('glsl/segmentDraw.frag')]
        });

        this.primitives.segments = new CustomPrimitive({
            geometry: particlePoints,
            attributeLocations: attributeLocations,
            primitiveType: Cesium.PrimitiveType.LINES,
            uniformMap: uniformMap,
            vertexShaderSource: vertexShaderSource,
            fragmentShaderSource: fragmentShaderSource,
            rawRenderState: rawRenderState,
            framebuffer: this.framebuffers.segments,
            autoClear: true
        });
    }

    initTrailsPrimitive() {
        const attributeLocations = {
            position: 0,
            st: 1
        };

        const that = this;
        const uniformMap = {
            segmentsColorTexture: function () {
                return that.framebuffers.segments.getColorTexture(0);
            },
            segmentsDepthTexture: function () {
                return that.framebuffers.segments.depthTexture;
            },
            currentTrailsColor: function () {
                return that.framebuffers.currentTrails.getColorTexture(0);
            },
            trailsDepthTexture: function () {
                return that.framebuffers.currentTrails.depthTexture;
            },
            fadeOpacity: function () {
                return that.particleSystemOptions.fadeOpacity;
            }
        };

        const rawRenderState = Util.createRawRenderState({
            viewport: undefined,
            depthTest: {
                enabled: true,
                func: Cesium.DepthFunction.ALWAYS // always pass depth test for the full control of depth information
            },
            depthMask: true
        });

        // prevent Cesium from writing depth because the depth here should be written manually
        const vertexShaderSource = new Cesium.ShaderSource({
            defines: ['DISABLE_GL_POSITION_LOG_DEPTH'],
            sources: [Util.loadText('glsl/fullscreen.vert')]
        });

        const fragmentShaderSource = new Cesium.ShaderSource({
            defines: ['DISABLE_LOG_DEPTH_FRAGMENT_WRITE'],
            sources: [Util.loadText('glsl/trailDraw.frag')]
        });

        this.primitives.trails = new CustomPrimitive({
            geometry: Util.getFullscreenQuad(),
            attributeLocations: attributeLocations,
            primitiveType: Cesium.PrimitiveType.TRIANGLES,
            uniformMap: uniformMap,
            vertexShaderSource: vertexShaderSource,
            fragmentShaderSource: fragmentShaderSource,
            rawRenderState: rawRenderState,
            framebuffer: this.framebuffers.nextTrails,
            autoClear: true
        });

        // redefine the preExecute function for ping-pong trails render
        this.primitives.trails.preExecute = function () {
            var temp;
            temp = that.framebuffers.currentTrails;
            that.framebuffers.currentTrails = that.framebuffers.nextTrails;
            that.framebuffers.nextTrails = temp;

            this.commandToExecute.framebuffer = that.framebuffers.nextTrails;
            this.clearCommand.framebuffer = that.framebuffers.nextTrails;
        }
    }

    initScreenPrimitive() {
        const attributeLocations = {
            position: 0,
            st: 1
        };

        const that = this;
        const uniformMap = {
            trailsColorTexture: function () {
                return that.framebuffers.nextTrails.getColorTexture(0);
            },
            trailsDepthTexture: function () {
                return that.framebuffers.nextTrails.depthTexture;
            }
        };

        const rawRenderState = Util.createRawRenderState({
            viewport: undefined,
            depthTest: {
                enabled: false
            },
            depthMask: true,
            blending: {
                enabled: true
            }
        });

        // prevent Cesium from writing depth because the depth here should be written manually
        const vertexShaderSource = new Cesium.ShaderSource({
            defines: ['DISABLE_GL_POSITION_LOG_DEPTH'],
            sources: [Util.loadText('glsl/fullscreen.vert')]
        });

        const fragmentShaderSource = new Cesium.ShaderSource({
            defines: ['DISABLE_LOG_DEPTH_FRAGMENT_WRITE'],
            sources: [Util.loadText('glsl/screenDraw.frag')]
        });

        this.primitives.screen = new CustomPrimitive({
            geometry: Util.getFullscreenQuad(),
            attributeLocations: attributeLocations,
            primitiveType: Cesium.PrimitiveType.TRIANGLES,
            uniformMap: uniformMap,
            vertexShaderSource: vertexShaderSource,
            fragmentShaderSource: fragmentShaderSource,
            rawRenderState: rawRenderState,
            framebuffer: undefined // undefined value means let Cesium deal with it
        });
    }

    clearFramebuffer() {
        this.clearCommand.framebuffer = this.framebuffers.segments;
        this.clearCommand.execute(this.context);

        this.clearCommand.framebuffer = this.framebuffers.currentTrails;
        this.clearCommand.execute(this.context);
        this.clearCommand.framebuffer = this.framebuffers.nextTrails;
        this.clearCommand.execute(this.context);
    }

    refreshParticle(viewerParameters) {
        this.clearFramebuffer();

        var lonLatRange = viewerParameters.lonLatRange;
        this.uniformVariables.lonRange.x = lonLatRange.lon.min;
        this.uniformVariables.lonRange.y = lonLatRange.lon.max;
        this.uniformVariables.latRange.x = lonLatRange.lat.min;
        this.uniformVariables.latRange.y = lonLatRange.lat.max;

        var pixelSize = viewerParameters.pixelSize;
        this.uniformVariables.relativeSpeedRange.x = this.particleSystemOptions.uvMinFactor * pixelSize;
        this.uniformVariables.relativeSpeedRange.y = this.particleSystemOptions.uvMaxFactor * pixelSize;

        this.particlesArray = DataProcess.randomizeParticleLonLatLev(this.particleSystemOptions.maxParticles, lonLatRange);

        this.outputTextures.fromParticles.destroy();
        this.outputTextures.toParticles.destroy();
        this.setupParticlesTextures();
    }

    canvasResize(cesiumContext) {
        this.outputTextures.fromParticles.destroy();
        this.outputTextures.toParticles.destroy();
        this.framebuffers.segments.destroy();
        this.framebuffers.currentTrails.destroy();
        this.framebuffers.nextTrails.destroy();

        this.context = cesiumContext;
        this.setupDataTextures();
        this.setupParticlesTextures();
        this.setupOutputFramebuffers();

        this.primitives.compute.commandToExecute.outputTexture = this.outputTextures.toParticles;
        this.primitives.segments.clearCommand.framebuffer = this.framebuffers.segments;
        this.primitives.segments.commandToExecute.framebuffer = this.framebuffers.segments;
        this.primitives.trails.clearCommand.framebuffer = this.framebuffers.nextTrails;
        this.primitives.trails.commandToExecute.framebuffer = this.framebuffers.nextTrails;
    }
}
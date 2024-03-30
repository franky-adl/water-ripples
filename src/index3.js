// ThreeJS and Third-party deps
import * as THREE from "three"
import * as dat from 'dat.gui'
import Stats from "three/examples/jsm/libs/stats.module"
import { GPUComputationRenderer } from "three/examples/jsm/misc/GPUComputationRenderer"
import { SimplexNoise } from "three/examples/jsm/math/SimplexNoise"
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass"

// Core boilerplate code deps
import { createComposer, createRenderer, runApp, updateLoadingProgressBar } from "./core-utils"

// Other deps
import WaterVertex from "./shaders/waterVertex.glsl"
import WaterFragment from "./shaders/waterFragment3.glsl"
import HeightmapFragment from "./shaders/heightmapFragment.glsl"
import SmoothFragment from "./shaders/smoothFragment.glsl"

global.THREE = THREE
// previously this feature is .legacyMode = false, see https://www.donmccurdy.com/2020/06/17/color-management-in-threejs/
// turning this on has the benefit of doing certain automatic conversions (for hexadecimal and CSS colors from sRGB to linear-sRGB)
THREE.ColorManagement.enabled = true

/**************************************************
 * 0. Tweakable parameters for the scene
 *************************************************/
const params = {
  // general scene params
  mouseSize: 20.0,
  viscosity: 0.98,
  waveHeight: 0.3,
  bloomStrength: 3.0,
  bloomRadius: 0.1,
  bloomThreshold: 0.0
}

// Texture width for simulation
const FBO_WIDTH = 512
const FBO_HEIGHT = 256
// Water size in system units
const GEOM_WIDTH = window.innerWidth
const GEOM_HEIGHT = window.innerWidth / 2

const simplex = new SimplexNoise()

/**************************************************
 * 1. Initialize core threejs components
 *************************************************/
// Create the scene
let scene = new THREE.Scene()

// Create the renderer via 'createRenderer',
// 1st param receives additional WebGLRenderer properties
// 2nd param receives a custom callback to further configure the renderer
let renderer = createRenderer({ antialias: true }, (_renderer) => {
  // best practice: ensure output colorspace is in sRGB, see Color Management documentation:
  // https://threejs.org/docs/#manual/en/introduction/Color-management
  _renderer.outputColorSpace = THREE.SRGBColorSpace
})

// Create the camera
// Pass in fov, near, far and camera position respectively
let camera = new THREE.OrthographicCamera(
  window.innerWidth / -2, // left
  window.innerWidth / 2,  // right
  window.innerHeight / 2, // top
  window.innerHeight / -2, // bottom
  -1000, // near plane
  1000 // far plane
)

// The RenderPass is already created in 'createComposer'
// Post-processing with Bloom effect
let bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  params.bloomStrength,
  params.bloomRadius,
  params.bloomThreshold
)
let composer = createComposer(renderer, scene, camera, (comp) => {
  comp.addPass(bloomPass)
})

/**************************************************
 * 2. Build your scene in this threejs app
 * This app object needs to consist of at least the async initScene() function (it is async so the animate function can wait for initScene() to finish before being called)
 * initScene() is called after a basic threejs environment has been set up, you can add objects/lighting to you scene in initScene()
 * if your app needs to animate things(i.e. not static), include a updateScene(interval, elapsed) function in the app as well
 *************************************************/
let app = {
  async initScene() {
    await updateLoadingProgressBar(0.1)

    this.mouseMoved = false
    this.mouseCoords = new THREE.Vector2()
    this.raycaster = new THREE.Raycaster()

    this.container.style.touchAction = 'none'
    this.container.addEventListener( 'pointermove', this.onPointerMove.bind(this) )

    const sun = new THREE.DirectionalLight( 0xFFFFFF, 5.0 )
    sun.position.set( 300, 400, 175 )
    scene.add( sun )

    const materialColor = 0xFFFFFF

    const geometry = new THREE.PlaneGeometry( GEOM_WIDTH, GEOM_HEIGHT, FBO_WIDTH, FBO_HEIGHT )

    // material: make a THREE.ShaderMaterial clone of THREE.MeshPhongMaterial, with customized vertex shader
    const material = new THREE.ShaderMaterial( {
      uniforms: THREE.UniformsUtils.merge( [
        THREE.ShaderLib[ 'phong' ].uniforms,
        {
          'heightmap': { value: null },
        }
      ] ),
      vertexShader: WaterVertex,
      fragmentShader: WaterFragment
    } );

    material.lights = true

    // Material attributes from THREE.MeshPhongMaterial
    // for the color map to work, we need all 3 lines (define material.color, material.map and material.uniforms[ 'map' ].value)
    material.color = new THREE.Color( materialColor )
    material.specular = new THREE.Color( 0x111111 )
    material.shininess = 50

    // Sets the uniforms with the material values
    material.uniforms[ 'diffuse' ].value = material.color
    material.uniforms[ 'specular' ].value = material.specular
    material.uniforms[ 'shininess' ].value = Math.max( material.shininess, 1e-4 )
    material.uniforms[ 'opacity' ].value = material.opacity

    // Defines
    material.defines.FBO_WIDTH = FBO_WIDTH.toFixed( 1 )
    material.defines.FBO_HEIGHT = FBO_HEIGHT.toFixed( 1 )
    material.defines.GEOM_WIDTH = GEOM_WIDTH.toFixed( 1 )
    material.defines.GEOM_HEIGHT = GEOM_HEIGHT.toFixed( 1 )

    this.waterUniforms = material.uniforms

    this.waterMesh = new THREE.Mesh( geometry, material )
    this.waterMesh.matrixAutoUpdate = false
    this.waterMesh.updateMatrix()

    scene.add( this.waterMesh )

    // Creates the gpu computation class and sets it up
    this.gpuCompute = new GPUComputationRenderer( FBO_WIDTH, FBO_HEIGHT, renderer )

    if ( renderer.capabilities.isWebGL2 === false ) {
      this.gpuCompute.setDataType( THREE.HalfFloatType )
    }

    const heightmap0 = this.gpuCompute.createTexture()

    this.fillTexture( heightmap0 )

    this.heightmapVariable = this.gpuCompute.addVariable( 'heightmap', HeightmapFragment, heightmap0 )

    this.gpuCompute.setVariableDependencies( this.heightmapVariable, [ this.heightmapVariable ] )

    this.heightmapVariable.material.uniforms[ 'mousePos' ] = { value: new THREE.Vector2( 10000, 10000 ) }
    this.heightmapVariable.material.uniforms[ 'mouseSize' ] = { value: 20.0 }
    this.heightmapVariable.material.uniforms[ 'viscosityConstant' ] = { value: 0.98 }
    this.heightmapVariable.material.uniforms[ 'waveheightMultiplier' ] = { value: 0.3 }
    this.heightmapVariable.material.defines.GEOM_WIDTH = GEOM_WIDTH.toFixed( 1 )
    this.heightmapVariable.material.defines.GEOM_HEIGHT = GEOM_HEIGHT.toFixed( 1 )

    const error = this.gpuCompute.init()
    if ( error !== null ) {
      console.error( error )
    }

    // Create compute shader to smooth the water surface and velocity
    this.smoothShader = this.gpuCompute.createShaderMaterial( SmoothFragment, { smoothTexture: { value: null } } )

    // GUI controls
    const gui = new dat.GUI()
    gui.add(params, "mouseSize", 1.0, 100.0, 1.0 ).onChange((newVal) => {
      this.heightmapVariable.material.uniforms[ 'mouseSize' ].value = newVal
    })
    gui.add(params, "viscosity", 0.9, 0.999, 0.001 ).onChange((newVal) => {
      this.heightmapVariable.material.uniforms[ 'viscosityConstant' ].value = newVal
    })
    gui.add(params, "waveHeight", 0.1, 2.0, 0.05 ).onChange((newVal) => {
      this.heightmapVariable.material.uniforms[ 'waveheightMultiplier' ].value = newVal
    })
    const buttonSmooth = {
      smoothWater: this.smoothWater.bind(this)
    }
    gui.add( buttonSmooth, 'smoothWater' )
    let bloomFolder = gui.addFolder("Bloom")
    bloomFolder.add(params, "bloomStrength", 0, 5, 0.05).onChange((val) => {
      bloomPass.strength = Number(val)
    })
    bloomFolder.add(params, "bloomRadius", 0, 2, 0.05).onChange((val) => {
      bloomPass.radius = Number(val)
    })
    bloomFolder.add(params, "bloomThreshold", 0, 1, 0.05).onChange((val) => {
      bloomPass.threshold = Number(val)
    })

    // Stats - show fps
    this.stats1 = new Stats()
    this.stats1.showPanel(0) // Panel 0 = fps
    this.stats1.domElement.style.cssText = "position:absolute;top:0px;left:0px;"
    // this.container is the parent DOM element of the threejs canvas element
    this.container.appendChild(this.stats1.domElement)

    await updateLoadingProgressBar(1.0, 100)
  },
  fillTexture( texture ) {
    const waterMaxHeight = 2;

    function noise( x, y ) {
      let multR = waterMaxHeight;
      let mult = 0.025;
      let r = 0;
      for ( let i = 0; i < 15; i ++ ) {
        r += multR * simplex.noise( x * mult, y * mult );
        multR *= 0.53 + 0.025 * i;
        mult *= 1.25;
      }

      return r;
    }

    const pixels = texture.image.data;

    let p = 0;
    for ( let j = 0; j < FBO_HEIGHT; j ++ ) {
      for ( let i = 0; i < FBO_WIDTH; i ++ ) {
        const x = i * 128 / FBO_WIDTH;
        const y = j * 128 / FBO_HEIGHT;

        pixels[ p + 0 ] = noise( x, y );
        pixels[ p + 1 ] = 0;
        pixels[ p + 2 ] = 0;
        pixels[ p + 3 ] = 1;

        p += 4;
      }
    }
  },
  smoothWater() {
    const currentRenderTarget = this.gpuCompute.getCurrentRenderTarget( this.heightmapVariable )
    const alternateRenderTarget = this.gpuCompute.getAlternateRenderTarget( this.heightmapVariable )

    for ( let i = 0; i < 10; i ++ ) {
      this.smoothShader.uniforms[ 'smoothTexture' ].value = currentRenderTarget.texture
      this.gpuCompute.doRenderTarget( this.smoothShader, alternateRenderTarget )

      this.smoothShader.uniforms[ 'smoothTexture' ].value = alternateRenderTarget.texture
      this.gpuCompute.doRenderTarget( this.smoothShader, currentRenderTarget )
    }
  },
  setMouseCoords( x, y ) {
    this.mouseCoords.set( ( x / renderer.domElement.clientWidth ) * 2 - 1, ( y / renderer.domElement.clientHeight ) * 2 - 1 )
    this.mouseMoved = true
  },
  onPointerMove( event ) {
    if ( event.isPrimary === false ) return
    this.setMouseCoords( event.clientX, event.clientY )
  },
  resize() {
    camera.left = window.innerWidth / -2
    camera.right = window.innerWidth / 2
    camera.top = window.innerHeight / 2
    camera.bottom = window.innerHeight / -2
    camera.updateProjectionMatrix()
  },
  // @param {number} interval - time elapsed between 2 frames
  // @param {number} elapsed - total time elapsed since app start
  updateScene(interval, elapsed) {
    // this.controls.update()
    this.stats1.update()

    // Set uniforms: mouse interaction
    const hmUniforms = this.heightmapVariable.material.uniforms
    if ( this.mouseMoved ) {

      this.raycaster.setFromCamera( this.mouseCoords, camera )

      const intersects = this.raycaster.intersectObject( this.waterMesh )

      if ( intersects.length > 0 ) {
        const point = intersects[ 0 ].point
        hmUniforms[ 'mousePos' ].value.set( point.x, point.y )
      } else {
        hmUniforms[ 'mousePos' ].value.set( 10000, 10000 )
      }

      this.mouseMoved = false
    } else {
      hmUniforms[ 'mousePos' ].value.set( 10000, 10000 )
    }

    // Do the gpu computation
    this.gpuCompute.compute()

    // Get compute output in custom uniform
    this.waterUniforms[ 'heightmap' ].value = this.gpuCompute.getCurrentRenderTarget( this.heightmapVariable ).texture
  }
}

/**************************************************
 * 3. Run the app
 * 'runApp' will do most of the boilerplate setup code for you:
 * e.g. HTML container, window resize listener, mouse move/touch listener for shader uniforms, THREE.Clock() for animation
 * Executing this line puts everything together and runs the app
 * ps. if you don't use custom shaders, pass undefined to the 'uniforms'(2nd-last) param
 * ps. if you don't use post-processing, pass undefined to the 'composer'(last) param
 *************************************************/
runApp(app, scene, renderer, camera, true, undefined, composer)

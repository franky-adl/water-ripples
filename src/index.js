// ThreeJS and Third-party deps
import * as THREE from "three"
import * as dat from 'dat.gui'
import Stats from "three/examples/jsm/libs/stats.module"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls"
import { GPUComputationRenderer } from "three/examples/jsm/misc/GPUComputationRenderer"
import { SimplexNoise } from "three/examples/jsm/math/SimplexNoise"

// Core boilerplate code deps
import { createCamera, createRenderer, runApp, updateLoadingProgressBar } from "./core-utils"

// Other deps
import WaterVertex from "./shaders/waterVertex.glsl"
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
  waveHeight: 0.3
}

// Texture width for simulation
const WIDTH = 128
const HEIGHT = 128
// Water size in system units
const BOUNDS_W = 512
const BOUNDS_H = 512

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
let camera = createCamera(75, 1, 3000, { x: 0, y: 200, z: 350 })

/**************************************************
 * 2. Build your scene in this threejs app
 * This app object needs to consist of at least the async initScene() function (it is async so the animate function can wait for initScene() to finish before being called)
 * initScene() is called after a basic threejs environment has been set up, you can add objects/lighting to you scene in initScene()
 * if your app needs to animate things(i.e. not static), include a updateScene(interval, elapsed) function in the app as well
 *************************************************/
let app = {
  async initScene() {
    // OrbitControls
    // this.controls = new OrbitControls(camera, renderer.domElement)
    // this.controls.enableDamping = true

    await updateLoadingProgressBar(0.1)

    this.mouseMoved = false
    this.mouseCoords = new THREE.Vector2()
    this.raycaster = new THREE.Raycaster()

    let waterMesh
    const waterNormal = new THREE.Vector3()

    this.container.style.touchAction = 'none'
    this.container.addEventListener( 'pointermove', this.onPointerMove.bind(this) )

    document.addEventListener( 'keydown', function ( event ) {
      // W Pressed: Toggle wireframe
      if ( event.keyCode === 87 ) {
        waterMesh.material.wireframe = ! waterMesh.material.wireframe
        waterMesh.material.needsUpdate = true
      }
    } )

    const sun = new THREE.DirectionalLight( 0xFFFFFF, 5.0 )
    sun.position.set( 300, 400, 175 )
    scene.add( sun )

    const sun2 = new THREE.DirectionalLight( 0x40A040, 0.6 )
    sun2.position.set( - 100, 350, - 200 )
    scene.add( sun2 )

    const materialColor = 0x0040C0;

    const geometry = new THREE.PlaneGeometry( BOUNDS_W, BOUNDS_H, WIDTH, HEIGHT );

    // material: make a THREE.ShaderMaterial clone of THREE.MeshPhongMaterial, with customized vertex shader
    const material = new THREE.ShaderMaterial( {
      uniforms: THREE.UniformsUtils.merge( [
        THREE.ShaderLib[ 'phong' ].uniforms,
        {
          'heightmap': { value: null },
        }
      ] ),
      vertexShader: WaterVertex,
      fragmentShader: THREE.ShaderChunk[ 'meshphong_frag' ]

    } );

    material.lights = true

    // Material attributes from THREE.MeshPhongMaterial
    material.color = new THREE.Color( materialColor )
    material.specular = new THREE.Color( 0x111111 )
    material.shininess = 50

    // Sets the uniforms with the material values
    material.uniforms[ 'diffuse' ].value = material.color
    material.uniforms[ 'specular' ].value = material.specular
    material.uniforms[ 'shininess' ].value = Math.max( material.shininess, 1e-4 )
    material.uniforms[ 'opacity' ].value = material.opacity

    // Defines
    material.defines.WIDTH = WIDTH.toFixed( 1 )
    material.defines.HEIGHT = HEIGHT.toFixed( 1 )
    material.defines.BOUNDS_W = BOUNDS_W.toFixed( 1 )
    material.defines.BOUNDS_H = BOUNDS_H.toFixed( 1 )

    this.waterUniforms = material.uniforms

    waterMesh = new THREE.Mesh( geometry, material )
    waterMesh.rotation.x = - Math.PI / 2
    waterMesh.matrixAutoUpdate = false
    waterMesh.updateMatrix()

    scene.add( waterMesh )

    // THREE.Mesh just for mouse raycasting
    const geometryRay = new THREE.PlaneGeometry( BOUNDS_W, BOUNDS_H, 1, 1 )
    this.meshRay = new THREE.Mesh( geometryRay, new THREE.MeshBasicMaterial( { color: 0xFFFFFF, visible: false } ) )
    this.meshRay.rotation.x = - Math.PI / 2
    this.meshRay.matrixAutoUpdate = false
    this.meshRay.updateMatrix()
    scene.add( this.meshRay )

    // Creates the gpu computation class and sets it up
    this.gpuCompute = new GPUComputationRenderer( WIDTH, HEIGHT, renderer )

    if ( renderer.capabilities.isWebGL2 === false ) {
      this.gpuCompute.setDataType( THREE.HalfFloatType )
    }

    const heightmap0 = this.gpuCompute.createTexture()

    this.fillTexture( heightmap0 )

    this.heightmapVariable = this.gpuCompute.addVariable( 'heightmap', HeightmapFragment, heightmap0 )

    this.gpuCompute.setVariableDependencies( this.heightmapVariable, [ this.heightmapVariable ] )

    this.heightmapVariable.material.uniforms[ 'mousePos' ] = { value: new THREE.Vector2( 10000, 10000 ) }
    this.heightmapVariable.material.uniforms[ 'mouseSize' ] = { value: params.mouseSize }
    this.heightmapVariable.material.uniforms[ 'viscosityConstant' ] = { value: params.viscosity }
    this.heightmapVariable.material.uniforms[ 'waveheightMultiplier' ] = { value: params.waveHeight }
    this.heightmapVariable.material.defines.BOUNDS_W = BOUNDS_W.toFixed( 1 )
    this.heightmapVariable.material.defines.BOUNDS_H = BOUNDS_H.toFixed( 1 )

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

    // Stats - show fps
    this.stats1 = new Stats()
    this.stats1.showPanel(0) // Panel 0 = fps
    this.stats1.domElement.style.cssText = "position:absolute;top:0px;left:0px;"
    // this.container is the parent DOM element of the threejs canvas element
    this.container.appendChild(this.stats1.domElement)

    await updateLoadingProgressBar(1.0, 100)
  },
  fillTexture( texture ) {
    const waterMaxHeight = 10;

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
    for ( let j = 0; j < HEIGHT; j ++ ) {
      for ( let i = 0; i < WIDTH; i ++ ) {
        const x = i * 128 / WIDTH;
        const y = j * 128 / HEIGHT;

        pixels[ p + 0 ] = noise( x, y );
        pixels[ p + 1 ] = pixels[ p + 0 ];
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
    this.mouseCoords.set( ( x / renderer.domElement.clientWidth ) * 2 - 1, - ( y / renderer.domElement.clientHeight ) * 2 + 1 )
    this.mouseMoved = true
  },
  onPointerMove( event ) {
    if ( event.isPrimary === false ) return
    this.setMouseCoords( event.clientX, event.clientY )
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

      const intersects = this.raycaster.intersectObject( this.meshRay )

      if ( intersects.length > 0 ) {
        const point = intersects[ 0 ].point
        hmUniforms[ 'mousePos' ].value.set( point.x, point.z )
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
runApp(app, scene, renderer, camera, true, undefined, undefined)

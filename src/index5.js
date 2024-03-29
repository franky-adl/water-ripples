// ThreeJS and Third-party deps
import * as THREE from "three"
import * as dat from 'dat.gui'
import Stats from "three/examples/jsm/libs/stats.module"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls"
import { GPUComputationRenderer } from "three/examples/jsm/misc/GPUComputationRenderer"
import { SimplexNoise } from "three/examples/jsm/math/SimplexNoise"
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass"

// Core boilerplate code deps
import { createCamera, createComposer, createRenderer, runApp, updateLoadingProgressBar } from "./core-utils"

// Other deps
import {hexToRgb} from "./common-utils"
import WaterVertex from "./shaders/waterVertex5.glsl"
import WaterFragment from "./shaders/waterFragment5.glsl"
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
  mouseSize: 80.0,
  viscosity: 0.999,
  waveHeight: 0.15,
  sunOneInt: 3.6,
  sunTwoInt: 2.5,
  colorOne: "#edbd0c",
  colorTwo: "#7800ff",
  colorTip: "#fc2348",
  colorTop: "#ff0000",
  bloomStrength: 3.0,
  bloomRadius: 0.1,
  bloomThreshold: 0.0
}

// Texture width for simulation
// note that if you use values other than power of 2, you'd notice seams on your final rendered cube sea
const WIDTH = 512
const HEIGHT = 256
// Water size in system units
const BOUNDS_W = 1000
const BOUNDS_H = 1000 / 2
// this controls the fps of the gpgpu renderer, thus controls the speed of the animated waves
const FPSInterval = 1/30
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
let camera = createCamera(45, 1, 5000, { x: -310, y: 100, z: 520 }, {x: -210, y: 0, z: 0})

// The RenderPass is already created in 'createComposer'
// Post-processing with Bloom effect
let bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  params.bloomStrength,
  params.bloomRadius,
  params.bloomThreshold
)
let composer = createComposer(renderer, scene, camera, (comp) => {
  // comp.addPass(bloomPass)
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

    // refresh the random values for waves poking every 5 seconds
    this.randX = this.randY = 0.5
    setInterval(() => {
      this.randX = Math.random() * BOUNDS_W
      this.randY = Math.random() * BOUNDS_H
    }, 5000)

    this.mouseMoved = false
    this.mouseCoords = new THREE.Vector2()

    let waterMesh
    this.delta = 0

    document.addEventListener( 'keydown', function ( event ) {
      // W Pressed: Toggle wireframe
      if ( event.keyCode === 87 ) {
        waterMesh.material.wireframe = ! waterMesh.material.wireframe
        waterMesh.material.needsUpdate = true
      }
    } )

    this.sun = new THREE.DirectionalLight( 0xFFFFFF, params.sunOneInt )
    this.sun.position.set( 300, 400, 175 )
    scene.add( this.sun )

    this.sun2 = new THREE.DirectionalLight( 0xFFFFFF, params.sunTwoInt )
    this.sun2.position.set( -300, 100, 175 )
    scene.add( this.sun2 )

    let baseGeometry = new THREE.BoxGeometry(4.0,4.0,4.0,1,1,1)

    let instancedGeometry = new THREE.InstancedBufferGeometry()
    //we have to copy the meat - geometry into this wrapper
    Object.keys(baseGeometry.attributes).forEach(attributeName=>{
      instancedGeometry.attributes[attributeName] = baseGeometry.attributes[attributeName]
    })
    //along with the index
    instancedGeometry.index = baseGeometry.index

    let instanceCount = WIDTH * HEIGHT
    instancedGeometry.maxInstancedCount = instanceCount

    // 1. Create the values for each instance
    let aPos = []
    let aUv = []
    for (let j = 0; j < HEIGHT; j++) {
      for (let i = 0; i < WIDTH; i++) {
        let posX = (i * 4 + 1) - WIDTH * 2
        let posZ = (j * 4 + 1) - HEIGHT * 2
        aPos.push(posX, 0, posZ)

        aUv.push(i/WIDTH, j/HEIGHT)
      }
    }
    // 2. Transform the array to float32
    let aPosFloat32 = new Float32Array(aPos)
    let aUvFloat32 = new Float32Array(aUv)
    // 3. Create the instanced Buffer Attribute of size three
    instancedGeometry.setAttribute("aPos", 
      new THREE.InstancedBufferAttribute(aPosFloat32, 3, false)
    )
    instancedGeometry.setAttribute("aUv", 
      new THREE.InstancedBufferAttribute(aUvFloat32, 2, false)
    )

    // material: make a THREE.ShaderMaterial clone of THREE.MeshPhongMaterial, with customized vertex shader
    const material = new THREE.ShaderMaterial( {
      uniforms: THREE.UniformsUtils.merge( [
        THREE.ShaderLib[ 'phong' ].uniforms,
        {
          'heightmap': { value: null },
          'u_time': { value: 0.0 },
          'colorOne': { value: hexToRgb(params.colorOne, true) },
          'colorTwo': { value: hexToRgb(params.colorTwo, true) },
          'colorTip': { value: hexToRgb(params.colorTip, true) },
          'colorTop': { value: hexToRgb(params.colorTop, true) },
        }
      ] ),
      vertexShader: WaterVertex,
      fragmentShader: WaterFragment
    } );

    material.lights = true

    this.waterUniforms = material.uniforms

    waterMesh = new THREE.Mesh(instancedGeometry, material)
    scene.add( waterMesh )

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
    gui.add(params, "sunOneInt", 0.1, 10.0, 0.05 ).onChange((newVal) => {
      this.sun.intensity = newVal
    })
    gui.add(params, "sunTwoInt", 0.1, 10.0, 0.05 ).onChange((newVal) => {
      this.sun2.intensity = newVal
    })
    gui.addColor(params, 'colorOne').name('color 1').onChange((val) => {
      let clr = new THREE.Color(val)
      this.waterUniforms[ 'colorOne' ].value = hexToRgb(clr.getHexString(), true)
    })
    gui.addColor(params, 'colorTwo').name('color 2').onChange((val) => {
      let clr = new THREE.Color(val)
      this.waterUniforms[ 'colorTwo' ].value = hexToRgb(clr.getHexString(), true)
    })
    gui.addColor(params, 'colorTip').name('color tip').onChange((val) => {
      let clr = new THREE.Color(val)
      this.waterUniforms[ 'colorTip' ].value = hexToRgb(clr.getHexString(), true)
    })
    gui.addColor(params, 'colorTop').name('color top').onChange((val) => {
      let clr = new THREE.Color(val)
      this.waterUniforms[ 'colorTop' ].value = hexToRgb(clr.getHexString(), true)
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
    const waterMaxHeight = 2

    function noise( x, y ) {
      let multR = waterMaxHeight
      let mult = 0.025
      let r = 0
      for ( let i = 0; i < 2; i ++ ) {
        r += multR * simplex.noise( x * mult, y * mult )
        multR *= 0.53 + 0.025 * i
        mult *= 1.25
      }
      return r
    }

    const pixels = texture.image.data

    let p = 0
    for ( let j = 0; j < HEIGHT; j ++ ) {
      for ( let i = 0; i < WIDTH; i ++ ) {
        const x = i * 128 / WIDTH
        const y = j * 128 / HEIGHT

        pixels[ p + 0 ] = noise(x,y)
        pixels[ p + 1 ] = 0
        pixels[ p + 2 ] = 0
        pixels[ p + 3 ] = 1

        p += 4
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
    this.mouseCoords.set( x - BOUNDS_W / 2, y - BOUNDS_H / 2 )
    this.mouseMoved = true
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

    // simulate mouse poking waves
    if (this.mouseMoved) {
      this.heightmapVariable.material.uniforms[ 'mousePos' ].value.set( this.mouseCoords.x, this.mouseCoords.y )
      this.mouseMoved = false
    } else {
      this.heightmapVariable.material.uniforms[ 'mousePos' ].value.set( 10000, 10000 )
    }

    // this controls the fps of the gpgpu renderer, thus controls the speed of the animated waves and be consistent across devices of various fps
    this.delta += interval
    if (this.delta > FPSInterval) {
      // Do the gpu computation
      this.gpuCompute.compute()
      this.delta = this.delta % FPSInterval
    }

    if (elapsed % 5 <= 0.5) {
      this.setMouseCoords(
        this.randX,
        this.randY)
    }

    // Get compute output in custom uniform
    this.waterUniforms[ 'heightmap' ].value = this.gpuCompute.getCurrentRenderTarget( this.heightmapVariable ).texture
    this.waterUniforms[ 'u_time' ].value = elapsed
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

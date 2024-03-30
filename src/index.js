// ThreeJS and Third-party deps
import * as THREE from "three"
import * as dat from 'dat.gui'
import Stats from "three/examples/jsm/libs/stats.module"
import { GPUComputationRenderer } from "three/examples/jsm/misc/GPUComputationRenderer"
import { SimplexNoise } from "three/examples/jsm/math/SimplexNoise"

// Core boilerplate code deps
import { createCamera, createRenderer, runApp, updateLoadingProgressBar } from "./core-utils"

// Other deps
import HeightmapFragment from "./shaders/heightmapFragment.glsl"

global.THREE = THREE
// previously this feature is .legacyMode = false, see https://www.donmccurdy.com/2020/06/17/color-management-in-threejs/
// turning this on has the benefit of doing certain automatic conversions (for hexadecimal and CSS colors from sRGB to linear-sRGB)
THREE.ColorManagement.enabled = true

/**************************************************
 * 0. Initialize core threejs components:
 * scene, renderer, camera
 *************************************************/
let scene = new THREE.Scene()

// 1st param receives additional WebGLRenderer properties
// 2nd param receives a custom callback to further configure the renderer
let renderer = createRenderer({ antialias: true }, (_renderer) => {
  // best practice: ensure output colorspace is in sRGB, see Color Management documentation:
  // https://threejs.org/docs/#manual/en/introduction/Color-management
  _renderer.outputColorSpace = THREE.SRGBColorSpace
})

// Pass in fov, near, far and camera position respectively
let camera = createCamera(75, 1, 3000, { x: 0, y: 200, z: 350 })

/**************************************************
 * 1. Tweakable parameters for the scene
 *************************************************/
const params = {
  // general scene params
  mouseSize: 20.0,
  viscosity: 0.98,
  waveHeight: 0.3,
}
// Texture width/height for simulation
const FBO_WIDTH = 128
const FBO_HEIGHT = 128
// Water geometry size in system units
const GEOM_WIDTH = 512
const GEOM_HEIGHT = 512

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
    this.pointer = new THREE.Vector2()
    this.raycaster = new THREE.Raycaster()
    this.container.addEventListener( 'pointermove', this.onPointerMove.bind(this) )

    const sun = new THREE.DirectionalLight( 0xFFFFFF, 5.0 )
    sun.position.set( 300, 400, 175 )
    scene.add( sun )
    const sun2 = new THREE.DirectionalLight( 0x40A040, 0.6 )
    sun2.position.set( - 100, 350, - 200 )
    scene.add( sun2 )

    // we minus 1 so as to match the number of pixels from the gpgpu texture
    const plane = new THREE.PlaneGeometry( GEOM_WIDTH, GEOM_HEIGHT, FBO_WIDTH - 1, FBO_HEIGHT - 1 );
    this.waterMat = new THREE.MeshPhongMaterial({
      color: new THREE.Color( 0x0040C0 )
    })
    
    // customize THREE.MeshPhongMaterial's vertex shader with onBeforeCompile
    // userData is the bridge for passing heightmap data from gpgpu to the water material's uniforms
    this.waterMat.userData.heightmap = { value: null }

    this.waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.heightmap = this.waterMat.userData.heightmap
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `
        uniform sampler2D heightmap;
        #include <common>
      `)
      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
        // Compute normal from heightmap
        vec2 cellSize = vec2( 1.0 / (${FBO_WIDTH.toFixed( 1 )}), 1.0 / ${FBO_HEIGHT.toFixed( 1 )} );
        vec3 objectNormal = vec3(
          ( texture2D( heightmap, uv + vec2( - cellSize.x, 0 ) ).x - texture2D( heightmap, uv + vec2( cellSize.x, 0 ) ).x ) * ${FBO_WIDTH.toFixed( 1 )} / ${GEOM_WIDTH.toFixed( 1 )},
          ( texture2D( heightmap, uv + vec2( 0, - cellSize.y ) ).x - texture2D( heightmap, uv + vec2( 0, cellSize.y ) ).x ) * ${FBO_HEIGHT.toFixed( 1 )} / ${GEOM_HEIGHT.toFixed( 1 )},
          1.0 );
      `)
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
        float heightValue = texture2D( heightmap, uv ).x;
        vec3 transformed = vec3( position.x, position.y, heightValue );
      `)
    }

    this.waterMesh = new THREE.Mesh( plane, this.waterMat )
    this.waterMesh.rotation.x = - Math.PI / 2
    // as the mesh is static, we can turn auto update off: https://threejs.org/docs/#manual/en/introduction/Matrix-transformations
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
    this.heightmapVariable.material.uniforms[ 'mouseSize' ] = { value: params.mouseSize }
    this.heightmapVariable.material.uniforms[ 'viscosityConstant' ] = { value: params.viscosity }
    this.heightmapVariable.material.uniforms[ 'waveheightMultiplier' ] = { value: params.waveHeight }
    this.heightmapVariable.material.defines.GEOM_WIDTH = GEOM_WIDTH.toFixed( 1 )
    this.heightmapVariable.material.defines.GEOM_HEIGHT = GEOM_HEIGHT.toFixed( 1 )

    const error = this.gpuCompute.init()
    if ( error !== null ) {
      console.error( error )
    }

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
    const simplex = new SimplexNoise()

    function layeredNoise( x, y ) {
      let multR = waterMaxHeight;
      let mult = 0.025;
      let r = 0;
      for ( let i = 0; i < 10; i ++ ) {
        r += multR * simplex.noise( x * mult, y * mult );
        multR *= 0.5;
        mult *= 2;
      }

      return r;
    }

    const pixels = texture.image.data;

    let p = 0;
    for ( let j = 0; j < FBO_HEIGHT; j ++ ) {
      for ( let i = 0; i < FBO_WIDTH; i ++ ) {
        const x = i * 128 / FBO_WIDTH;
        const y = j * 128 / FBO_HEIGHT;

        pixels[ p + 0 ] = layeredNoise( x, y );
        pixels[ p + 1 ] = 0;
        pixels[ p + 2 ] = 0;
        pixels[ p + 3 ] = 1;

        p += 4;
      }
    }
  },
  onPointerMove( event ) {
    if ( event.isPrimary === false ) return
    // converting mouse coordinates into -1 to +1 space
    this.pointer.x = ( event.clientX / window.innerWidth ) * 2 - 1
    this.pointer.y = - ( event.clientY / window.innerHeight ) * 2 + 1
    this.mouseMoved = true
  },
  // @param {number} interval - time elapsed between 2 consecutive frames
  // @param {number} elapsed - total time elapsed since app start
  updateScene(interval, elapsed) {
    this.stats1.update()

    // Set uniforms: mouse interaction
    const hmUniforms = this.heightmapVariable.material.uniforms
    if ( this.mouseMoved ) {
      this.raycaster.setFromCamera( this.pointer, camera )
      const intersects = this.raycaster.intersectObject( this.waterMesh )

      if ( intersects.length > 0 ) {
        const point = intersects[ 0 ].point
        // point is in world coordinates
        hmUniforms[ 'mousePos' ].value.set( point.x, point.z )
      } else {
        hmUniforms[ 'mousePos' ].value.set( 10000, 10000 )
      }

      this.mouseMoved = false
    } else {
      hmUniforms[ 'mousePos' ].value.set( 10000, 10000 )
    }

    // Do the gpgpu computation
    this.gpuCompute.compute()

    this.waterMat.userData.heightmap.value = this.gpuCompute.getCurrentRenderTarget( this.heightmapVariable ).texture
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
runApp(app, scene, renderer, camera, true)

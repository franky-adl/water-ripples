// ThreeJS and Third-party deps
import * as THREE from "three"
import * as dat from 'dat.gui'
import Stats from "three/examples/jsm/libs/stats.module"
import { GPUComputationRenderer } from "three/examples/jsm/misc/GPUComputationRenderer"
import { SimplexNoise } from "three/examples/jsm/math/SimplexNoise"

// Core boilerplate code deps
import { createCamera, createRenderer, runApp, updateLoadingProgressBar, getDefaultUniforms } from "./core-utils"

// Other deps
import { loadTexture } from "./common-utils"
import HeightmapFragment from "./shaders/heightmapFragment.glsl"
import SmoothFragment from "./shaders/smoothFragment.glsl"
// mosaic pattern from https://www.sketchuptextureclub.com/textures/architecture/tiles-interior/mosaico/pool-tiles/mosaico-pool-tiles-texture-seamless-15699
import Mosaic from "./assets/mosaic.jpg"
import PoolSide from "./assets/Poolside3.jpg"

global.THREE = THREE
// previously this feature is .legacyMode = false, see https://www.donmccurdy.com/2020/06/17/color-management-in-threejs/
// turning this on has the benefit of doing certain automatic conversions (for hexadecimal and CSS colors from sRGB to linear-sRGB)
THREE.ColorManagement.enabled = true

// reference from https://tympanus.net/codrops/2020/01/07/playing-with-texture-projection-in-three-js/

/**************************************************
 * 0. Tweakable parameters for the scene
 *************************************************/
const params = {
  // general scene params
  mouseSize: 20.0,
  viscosity: 0.999,
  waveHeight: 0.5,
}

const uniforms = {
  ...getDefaultUniforms()
}

// Texture width for simulation
const FBO_WIDTH = 512
const FBO_HEIGHT = 256
// Water size in system units
const GEOM_WIDTH = 1000
const GEOM_HEIGHT = 1000 / 2

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
let camera = createCamera(50, 1, 3000, { x: 0, y: 0, z: 500 })

/**************************************************
 * 2. Build your scene in this threejs app
 * This app object needs to consist of at least the async initScene() function (it is async so the animate function can wait for initScene() to finish before being called)
 * initScene() is called after a basic threejs environment has been set up, you can add objects/lighting to you scene in initScene()
 * if your app needs to animate things(i.e. not static), include a updateScene(interval, elapsed) function in the app as well
 *************************************************/
let app = {
  async initScene() {
    let PoolTexture = await loadTexture(Mosaic)
    // assigning image textures with SRGBColorSpace is essential in getting the rendered colors correct
    PoolTexture.colorSpace = THREE.SRGBColorSpace
    PoolTexture.wrapS = THREE.RepeatWrapping
    PoolTexture.wrapT = THREE.RepeatWrapping
    PoolTexture.repeat.set(4,2)

    let PoolSquareTexture = PoolTexture.clone()
    PoolSquareTexture.repeat.set(2,2)

    await updateLoadingProgressBar(0.1)

    let PoolSideTexture = await loadTexture(PoolSide)
    PoolSideTexture.colorSpace = THREE.SRGBColorSpace

    await updateLoadingProgressBar(0.3)

    this.mouseMoved = false
    this.mouseCoords = new THREE.Vector2()
    this.raycaster = new THREE.Raycaster()

    this.container.style.touchAction = 'none'
    this.container.addEventListener( 'pointermove', this.onPointerMove.bind(this) )

    // set up lighting
    const sun = new THREE.DirectionalLight( 0xFFFFFF, 2.5 )
    sun.position.set( 300, 800, 350 )
    scene.add( sun )
    const ambient = new THREE.AmbientLight( 0xFFFFFF, 0.7 )
    scene.add( ambient )

    // create backdrop
    let bgPlane = new THREE.PlaneGeometry( 1500, 750 )
    let bgMat = new THREE.MeshBasicMaterial({
      map: PoolSideTexture
    })
    let backdrop = new THREE.Mesh(bgPlane, bgMat)
    backdrop.position.set(0, 300, -260)
    scene.add(backdrop)

    const geometry = new THREE.PlaneGeometry( GEOM_WIDTH, GEOM_HEIGHT, FBO_WIDTH, FBO_HEIGHT )

    // create a new camera from which to project
    let cam2 = new THREE.OrthographicCamera(-600, 600, 500, -500, 1, 2000)
    cam2.position.set(300, 800, 350)
    cam2.lookAt(0,0,0)
    // make sure the cam2 matrices are updated
    cam2.updateProjectionMatrix()
    cam2.updateMatrixWorld()
    cam2.updateWorldMatrix()
    // get the matrices from the camera so they're fixed in camera's original position
    // viewMatrixCamera tested by maths to show it does transforms world coordinates to p-cam's view coordinates
    // modelMatrixCamera tested by maths to show it is the inverse of viewMatrixCamera
    const viewMatrixCamera = cam2.matrixWorldInverse.clone()
    const projectionMatrixCamera = cam2.projectionMatrix.clone()
    const projectionMatrixInverseCamera = cam2.projectionMatrixInverse.clone()
    const modelMatrixCamera = cam2.matrixWorld.clone()

    // plane equation: https://tutorial.math.lamar.edu/classes/calciii/eqnsofplanes.aspx
    let plane_point = new THREE.Vector3(0,250,0)
    // previous mistake I made here is to directly apply the matrix transformation to the unit normal vector...
    // don't make the same mistake again next time caz that costed me a whole day to figure out what's wrong
    let n_pt1 = new THREE.Vector3(0,250,0)
    let n_pt2 = new THREE.Vector3(0,251,0)
    let pool_view_npt1 = n_pt1.applyMatrix4(viewMatrixCamera)
    let pool_view_npt2 = n_pt2.applyMatrix4(viewMatrixCamera)
    let pool_view_nv = pool_view_npt2.sub(pool_view_npt1)
    let pool_view_pt = plane_point.applyMatrix4(viewMatrixCamera)
    let coef_d = pool_view_nv.x * pool_view_pt.x + pool_view_nv.y * pool_view_pt.y + pool_view_nv.z * pool_view_pt.z
    let plane_coefs = new THREE.Vector4(pool_view_nv.x, pool_view_nv.y, pool_view_nv.z, coef_d)
    
    this.poolGeom = new THREE.BoxGeometry(1000,500,500,1,1,1)

    // testing override
    this.poolMat = new THREE.MeshPhongMaterial({
      color: new THREE.Color(0xffffff),
      map: PoolTexture,
      side: THREE.BackSide,
    })
    this.poolMatSq = new THREE.MeshPhongMaterial({
      color: new THREE.Color(0xffffff),
      map: PoolSquareTexture,
      side: THREE.BackSide,
    })
    this.poolMatRf = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
    })

    // add custom shader code to the pool materials
    this.poolMat.userData.heightmap = { value: null }
    const obc_poolmat = (shader) => {
      shader.uniforms.heightmap = this.poolMat.userData.heightmap
      shader.uniforms.viewMatrixCamera = { type: 'm4', value: viewMatrixCamera }
      shader.uniforms.projectionMatrixCamera = { type: 'm4', value: projectionMatrixCamera }
      shader.uniforms.projectionMatrixInverseCamera = { type: 'm4', value: projectionMatrixInverseCamera }
      shader.uniforms.modelMatrixCamera = { type: 'mat4', value: modelMatrixCamera }
      shader.uniforms.plane_coefs = { type: 'v4', value: plane_coefs }
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `
        uniform mat4 viewMatrixCamera;
        uniform mat4 projectionMatrixCamera;
        uniform mat4 projectionMatrixInverseCamera;
        uniform mat4 modelMatrixCamera;
        uniform vec4 plane_coefs;
        varying vec2 poolUv;

        #include <common>
      `);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>

        // first we need to get the coordinates of the pool as seen from the projector cam
        vec4 vTexCoords = viewMatrixCamera * modelMatrix * vec4(position, 1.0);
        vec4 vPoolCoords = vTexCoords;
        // then we "lift up" those coordinates to the plane of the pool surface,
        // note that the plane equation we use here is already in projector cam's view space
        vPoolCoords.z = (plane_coefs.w - plane_coefs.x * vTexCoords.x - plane_coefs.y * vTexCoords.y) / plane_coefs.z;
        // get world coordinates of the pool surface by transforming back from projector cam's view space
        vPoolCoords = modelMatrixCamera * vPoolCoords;
        // further transform those into uv coordinates of the pool surface
        // todo: parametrize these numbers
        poolUv = (vPoolCoords.xz + vec2(500., 250.)) / vec2(1000.,500.);
        // inverse the v coords to be correct
        poolUv.y = 1. - poolUv.y;
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
        uniform sampler2D heightmap;
        varying vec2 poolUv;

        #include <common>
      `);
      shader.fragmentShader = shader.fragmentShader.replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
        vec4 diffuseColor = vec4( diffuse, opacity );

        vec3 refractedPoolLight = vec3(0.);

        if (poolUv.x >= 0. && poolUv.x <= 1. && poolUv.y >= 0. && poolUv.y <= 1.) {
          // raise base luminosity to simulate sun light hitting the pool at an angle
          diffuseColor.rgb += vec3(1.0,1.0,1.0);
        }
        // hand-calibrated thresholds such that the refracted lights do not creep through over the water surface
        if (poolUv.x >= 0.007 && poolUv.x <= 1. && poolUv.y >= 0. && poolUv.y <= 0.985) {
          vec4 hm = texture2D(heightmap, poolUv);
          float hV = hm.x;

          // we would like to mimick real life sunlight refractions in swimming pools
          // so we need a texture that accentuates the lit pixels, creating a cell-like grid with thin light seams
          // to do this we'd need to first abs the original heightmap values, to create those accute turns
          // square-rooting it next further accentuates those sharp turns
          // however until now these sharp turns are still touching y=0, which means they are dark seams instead of light seams
          // so we'd need to reverse the curve by deducting it from a higher number, which is where the "energy" value eV is introduced
          // we can use a fixed number as long as we keep pumping out waves (if waves die away, the pool will light up more and more)
          float lightPattern = pow(3.-pow(abs(hV),0.5), 2.) * 0.3;
          
          refractedPoolLight = vec3(lightPattern);
        }
        diffuseColor.rgb += refractedPoolLight;
      `);
    }
    this.poolMat.onBeforeCompile = obc_poolmat
    this.poolMatSq.onBeforeCompile = obc_poolmat

    this.pool = new THREE.Mesh(this.poolGeom, [
      this.poolMatSq, //px
      this.poolMatSq, //nx
      this.poolMatRf, //py
      this.poolMat, //ny
      this.poolMat, //pz
      this.poolMat, //nz
    ])
    scene.add(this.pool)

    // material: make a THREE.ShaderMaterial clone of THREE.MeshPhongMaterial, with customized vertex shader
    this.surfaceMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0xbef1ff),
      roughness: 0.2,
      transmission: 1,
      thickness: 1.5,
      side: THREE.BackSide
    })
    // add custom shader code to the pool materials
    this.surfaceMat.userData.heightmap = { value: null }
    const obc_surfaceMat = (shader) => {
      shader.uniforms.heightmap = this.surfaceMat.userData.heightmap
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `
        uniform sampler2D heightmap;

        #include <common>
      `);
      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
        // Compute normal from heightmap
        vec2 cellSize = vec2( 1.0 / (FBO_WIDTH), 1.0 / FBO_HEIGHT );
        vec3 objectNormal = vec3(
            ( texture2D( heightmap, uv + vec2( - cellSize.x, 0 ) ).x - texture2D( heightmap, uv + vec2( cellSize.x, 0 ) ).x ) * FBO_WIDTH / GEOM_WIDTH,
            ( texture2D( heightmap, uv + vec2( 0, - cellSize.y ) ).x - texture2D( heightmap, uv + vec2( 0, cellSize.y ) ).x ) * FBO_HEIGHT / GEOM_HEIGHT,
            1.0 );
      `);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
        float heightValue = texture2D( heightmap, uv ).x;
        vec3 transformed = vec3( position.x, position.y, heightValue );
      `);
    }
    this.surfaceMat.onBeforeCompile = obc_surfaceMat
    // Defines
    this.surfaceMat.defines.FBO_WIDTH = FBO_WIDTH.toFixed( 1 )
    this.surfaceMat.defines.FBO_HEIGHT = FBO_HEIGHT.toFixed( 1 )
    this.surfaceMat.defines.GEOM_WIDTH = GEOM_WIDTH.toFixed( 1 )
    this.surfaceMat.defines.GEOM_HEIGHT = GEOM_HEIGHT.toFixed( 1 )

    this.waterMesh = new THREE.Mesh( geometry, this.surfaceMat )
    this.waterMesh.rotation.x = -Math.PI/2
    this.waterMesh.position.y = 230
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
    const waterMaxHeight = 0.8;

    function noise( x, y ) {
      let multR = waterMaxHeight;
      let mult = 0.025;
      let r = 0;
      for ( let i = 0; i < 10; i ++ ) {
        r += multR * simplex.noise( x * mult, y * mult );
        multR *= 0.3 + 0.025 * i;
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
    console.log(event.clientX, event.clientY)
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
    this.stats1.update()

    // add simulated random mouse events to keep the waves moving
    let xStart = Math.random() * window.innerWidth
    let yStart = Math.random() * window.innerHeight
    this.setMouseCoords(xStart, yStart)

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
    this.surfaceMat.userData.heightmap.value = this.gpuCompute.getCurrentRenderTarget( this.heightmapVariable ).texture
    this.poolMat.userData.heightmap.value = this.gpuCompute.getCurrentRenderTarget( this.heightmapVariable ).texture
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
runApp(app, scene, renderer, camera, true, uniforms)

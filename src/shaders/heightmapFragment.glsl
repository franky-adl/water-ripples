#define PI 3.1415926538

uniform vec2 mousePos;
uniform float mouseSize;
uniform float viscosityConstant;
uniform float waveheightMultiplier;

void main()	{
    // The size of the computation (sizeX * sizeY) is defined as 'resolution' automatically in the shader.
    // sizeX and sizeY are passed as params when you make a new GPUComputationRenderer instance.
    vec2 cellSize = 1.0 / resolution.xy;

    // gl_FragCoord is in pixels (coordinates range from 0.0 to the width/height of the window,
    // note that the window isn't the visible one on your browser here, since the gpgpu renders to its virtual screen
    // thus the uv still is 0..1
    vec2 uv = gl_FragCoord.xy * cellSize;

    // heightmapValue.x == height from previous frame
    // heightmapValue.y == height from penultimate frame
    // heightmapValue.z, heightmapValue.w not used
    vec4 heightmapValue = texture2D( heightmap, uv );

    // Get neighbours
    vec4 north = texture2D( heightmap, uv + vec2( 0.0, cellSize.y ) );
    vec4 south = texture2D( heightmap, uv + vec2( 0.0, - cellSize.y ) );
    vec4 east = texture2D( heightmap, uv + vec2( cellSize.x, 0.0 ) );
    vec4 west = texture2D( heightmap, uv + vec2( - cellSize.x, 0.0 ) );

    // https://web.archive.org/web/20080618181901/http://freespace.virgin.net/hugo.elias/graphics/x_water.htm
    // change in height is proportional to the height of the wave 2 frames older
    // so new height is equaled to the smoothed height plus the change in height
    float newHeight = ( ( north.x + south.x + east.x + west.x ) * 0.5 - heightmapValue.y ) * viscosityConstant;

    // Mouse influence
    float mousePhase = clamp( length( ( uv - vec2( 0.5 ) ) * vec2(GEOM_WIDTH, GEOM_HEIGHT) - vec2( mousePos.x, - mousePos.y ) ) * PI / mouseSize, 0.0, PI );
    newHeight += ( cos( mousePhase ) + 1.0 ) * waveheightMultiplier;

    heightmapValue.y = heightmapValue.x;
    heightmapValue.x = newHeight;

    gl_FragColor = heightmapValue;

}
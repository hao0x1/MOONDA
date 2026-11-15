// A thin, typed door to CesiumJS's own low-level drawing classes.
//
// Cesium exports them at runtime (DrawCommand, VertexArray, Buffer, ShaderProgram, RenderState,
// Texture, Sampler) but leaves them out of its TypeScript typings because they are "private".
// The sky needs them: it is drawn with its own small shaders, the same way Cesium draws its own
// sky box and Sun. Everything comes from the ONE `cesium` module the rest of the app uses.

import * as CesiumAll from 'cesium';
import { ComponentDatatype, PixelFormat, PrimitiveType, WebGLConstants } from 'cesium';
import { isPhoneGraphics } from '../../app/quality';

export interface GlContext { readonly webgl2: boolean; readonly drawingBufferWidth: number; readonly drawingBufferHeight: number }
export interface GlTexture { destroy(): void; generateMipmap(): void; readonly width: number; readonly height: number }
export interface GlBuffer { copyFromArrayView(view: ArrayBufferView, offsetInBytes?: number): void; destroy(): void }
export interface GlVertexArray { destroy(): void }
export interface GlShaderProgram { destroy(): void; _bind(): void }
export type UniformMap = Record<string, () => unknown>;
export interface GlDrawCommand { execute(context: GlContext, passState: unknown): void; offset: number; count: number | undefined; vertexArray: GlVertexArray; shaderProgram: GlShaderProgram | undefined }

interface Private {
  Buffer: { createVertexBuffer(o: { context: GlContext; typedArray: ArrayBufferView; usage: number }): GlBuffer; createIndexBuffer(o: { context: GlContext; typedArray: ArrayBufferView; usage: number; indexDatatype: number }): GlBuffer };
  BufferUsage: { STATIC_DRAW: number; DYNAMIC_DRAW: number };
  VertexArray: new (o: { context: GlContext; attributes: object[]; indexBuffer?: GlBuffer }) => GlVertexArray;
  ShaderProgram: { fromCache(o: { context: GlContext; vertexShaderSource: string; fragmentShaderSource: string; attributeLocations: Record<string, number> }): GlShaderProgram };
  RenderState: { fromCache(o: object): object };
  DrawCommand: new (o: object) => GlDrawCommand;
  Texture: new (o: object) => GlTexture;
  Sampler: new (o: object) => object;
  ContextLimits: { maximumTextureSize: number; maximumAliasedPointSize: number; maximumTextureFilterAnisotropy: number };
  Pass: { ENVIRONMENT: number };
}
const P = CesiumAll as unknown as Private;

export const limits = () => P.ContextLimits;

export interface Attribute { name: string; data: Float32Array | Uint8Array; size: number; normalize?: boolean; dynamic?: boolean }
export interface Mesh { vertexArray: GlVertexArray; buffers: GlBuffer[]; locations: Record<string, number> }

/** Upload vertex data: one buffer per attribute (simple, and a dynamic one can be refreshed on its own). */
export function createMesh(context: GlContext, attributes: Attribute[], indices?: Uint16Array | Uint32Array): Mesh {
  const locations: Record<string, number> = {};
  const buffers: GlBuffer[] = [];
  const attrs = attributes.map((a, index) => {
    locations[a.name] = index;
    const vertexBuffer = P.Buffer.createVertexBuffer({ context, typedArray: a.data, usage: a.dynamic ? P.BufferUsage.DYNAMIC_DRAW : P.BufferUsage.STATIC_DRAW });
    buffers.push(vertexBuffer);
    return {
      index, vertexBuffer, componentsPerAttribute: a.size, normalize: !!a.normalize,
      componentDatatype: a.data instanceof Uint8Array ? ComponentDatatype.UNSIGNED_BYTE : ComponentDatatype.FLOAT,
    };
  });
  const indexBuffer = indices && P.Buffer.createIndexBuffer({
    context, typedArray: indices, usage: P.BufferUsage.STATIC_DRAW,
    indexDatatype: indices instanceof Uint32Array ? WebGLConstants.UNSIGNED_INT : WebGLConstants.UNSIGNED_SHORT,
  });
  return { vertexArray: new P.VertexArray({ context, attributes: attrs, indexBuffer }), buffers, locations };
}

export type Blend = 'none' | 'add' | 'over';
const BLEND: Record<Blend, object> = {
  none: { enabled: false },
  // light adds up (stars, glare); the picture's alpha is left alone
  add: { enabled: true, functionSourceRgb: WebGLConstants.ONE, functionDestinationRgb: WebGLConstants.ONE, functionSourceAlpha: WebGLConstants.ZERO, functionDestinationAlpha: WebGLConstants.ONE },
  // a solid thing in front (Earth, name tags); colours are pre-multiplied by alpha
  over: { enabled: true, functionSourceRgb: WebGLConstants.ONE, functionDestinationRgb: WebGLConstants.ONE_MINUS_SRC_ALPHA, functionSourceAlpha: WebGLConstants.ZERO, functionDestinationAlpha: WebGLConstants.ONE },
};

export interface DrawSpec {
  context: GlContext; mesh: Mesh; vertex: string; fragment: string; uniforms: UniformMap;
  blend: Blend; points?: boolean; cullBack?: boolean; owner: object;
}
export interface Drawable { command: GlDrawCommand; program: GlShaderProgram; mesh: Mesh }

/**
 * One draw call for the sky pass: no depth test and no depth write (the sky is painted first and the
 * Moon is painted over it). Compiles the shader right away, so a broken shader throws HERE (where the
 * caller can switch that part of the sky off) and not in the middle of drawing a frame.
 */
export function createDrawable(spec: DrawSpec): Drawable {
  const program = P.ShaderProgram.fromCache({ context: spec.context, vertexShaderSource: spec.vertex, fragmentShaderSource: spec.fragment, attributeLocations: spec.mesh.locations });
  program._bind();
  const renderState = P.RenderState.fromCache({
    depthTest: { enabled: false }, depthMask: false, blending: BLEND[spec.blend],
    cull: { enabled: !!spec.cullBack, face: WebGLConstants.BACK },
  });
  const command = new P.DrawCommand({
    vertexArray: spec.mesh.vertexArray, shaderProgram: program, renderState, uniformMap: spec.uniforms,
    primitiveType: spec.points ? PrimitiveType.POINTS : PrimitiveType.TRIANGLES,
    pass: P.Pass.ENVIRONMENT, cull: false, owner: spec.owner,
  });
  return { command, program, mesh: spec.mesh };
}

export function destroyDrawable(d: Drawable | null) {
  if (!d) return;
  d.mesh.vertexArray.destroy(); // also frees its buffers
  d.program.destroy();
}

export interface TextureSpec { context: GlContext; source: ImageBitmap | HTMLCanvasElement | HTMLImageElement; grey?: boolean; repeatX?: boolean; mipmaps?: boolean; alpha?: boolean; premultiply?: boolean }

/** Picture -> GPU texture. Row 0 of the picture is texture coordinate t = 0 (no flip), for every kind of source. */
export function createTexture(spec: TextureSpec): GlTexture {
  const mip = spec.mipmaps !== false;
  // Some phones only accept 4096px textures; Smooth also keeps the sky's decoded pictures small.
  const maxSize = Math.min(P.ContextLimits.maximumTextureSize, isPhoneGraphics() ? 1024 : Infinity);
  let source = spec.source;
  if (source.width > maxSize || source.height > maxSize) {
    const scale = maxSize / Math.max(source.width, source.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(source.width * scale));
    canvas.height = Math.max(1, Math.floor(source.height * scale));
    canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
    source = canvas;
  }
  const sampler = new P.Sampler({
    wrapS: spec.repeatX ? WebGLConstants.REPEAT : WebGLConstants.CLAMP_TO_EDGE, wrapT: WebGLConstants.CLAMP_TO_EDGE,
    minificationFilter: mip ? WebGLConstants.LINEAR_MIPMAP_LINEAR : WebGLConstants.LINEAR, magnificationFilter: WebGLConstants.LINEAR,
    maximumAnisotropy: mip ? Math.min(8, P.ContextLimits.maximumTextureFilterAnisotropy || 1) : 1,
  });
  const texture = new P.Texture({
    context: spec.context, source, flipY: false, preMultiplyAlpha: !!spec.premultiply, skipColorSpaceConversion: true, sampler,
    pixelFormat: spec.alpha ? PixelFormat.RGBA : spec.grey ? PixelFormat.LUMINANCE : PixelFormat.RGB,
  });
  if (mip) texture.generateMipmap();
  return texture;
}

/**
 * Download and decode a picture without blocking the page. Goes through an <img> (not fetch + Blob): Chrome
 * keeps big Blobs on disk and refuses them when the disk is nearly full, which made the 10 MB sky map fail.
 */
export async function loadBitmap(url: string): Promise<ImageBitmap> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  const maxSize = Math.min(P.ContextLimits.maximumTextureSize, isPhoneGraphics() ? 1024 : Infinity);
  const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
  const bitmap = await createImageBitmap(img, {
    imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    ...(scale < 1 ? { resizeWidth: Math.max(1, Math.floor(img.naturalWidth * scale)), resizeHeight: Math.max(1, Math.floor(img.naturalHeight * scale)), resizeQuality: 'high' } : {}),
  });
  if (scale < 1) img.src = ''; // release the full-size decode after making the phone's smaller picture
  return bitmap;
}

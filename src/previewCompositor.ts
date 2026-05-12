import { MutableRefObject, useEffect, useRef, useState } from 'react';
import { createEffectUniforms, type EffectSettings, hasActiveEffects } from './effects';
import { performanceMonitor } from './performanceMonitor';

type VideoElementWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export type PreviewCompositorOptions = {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  effects: EffectSettings;
  enabled: boolean;
  videoRef: MutableRefObject<HTMLVideoElement | null>;
};

const SHADER = `
struct Uniforms {
  brightness: f32,
  contrast: f32,
  saturation: f32,
  pad: f32,
};

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vertex_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0),
    vec2f(1.0, -1.0),
    vec2f(1.0, 1.0)
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0),
    vec2f(1.0, 1.0),
    vec2f(0.0, 0.0),
    vec2f(0.0, 0.0),
    vec2f(1.0, 1.0),
    vec2f(1.0, 0.0)
  );
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

@group(0) @binding(0) var videoTexture: texture_external;
@group(0) @binding(1) var videoSampler: sampler;
@group(0) @binding(2) var<uniform> settings: Uniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  var color = textureSampleBaseClampToEdge(videoTexture, videoSampler, input.uv).rgb;
  color = (color - vec3f(0.5)) * settings.contrast + vec3f(0.5);
  let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  color = mix(vec3f(luma), color, settings.saturation);
  color = color + vec3f(settings.brightness);
  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

function resizeCanvas(canvas: HTMLCanvasElement) {
  const scale = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

export function usePreviewCompositor({ canvasRef, effects, enabled, videoRef }: PreviewCompositorOptions) {
  const [isGpuPreviewActive, setIsGpuPreviewActive] = useState(false);
  const effectsRef = useRef(effects);
  const renderRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    effectsRef.current = effects;
    renderRef.current?.();
  }, [effects]);

  useEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;
    let videoFrameId: number | null = null;
    let device: GPUDevice | null = null;
    let cleanupGpuListeners: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const video = videoRef.current as VideoElementWithFrameCallback | null;
    const canvas = canvasRef.current;
    const shouldComposite = enabled && hasActiveEffects(effectsRef.current) && Boolean(navigator.gpu);

    if (!video || !canvas || !shouldComposite) {
      setIsGpuPreviewActive(false);
      performanceMonitor.setGpuPreviewActive(false);
      renderRef.current = null;
      return;
    }

    async function start() {
      const adapter = await navigator.gpu.requestAdapter();

      if (!adapter || cancelled || !canvas || !video) {
        return;
      }

      const newDevice = await adapter.requestDevice();

      if (cancelled || !canvas || !video) {
        newDevice.destroy();
        return;
      }

      device = newDevice;
      const context = canvas.getContext('webgpu');

      if (!context || cancelled) {
        device.destroy();
        device = null;
        return;
      }

      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({
        alphaMode: 'premultiplied',
        device,
        format,
      });

      const uniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
      });
      const sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
      });
      const bindGroupLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            externalTexture: {},
            visibility: GPUShaderStage.FRAGMENT,
          },
          {
            binding: 1,
            sampler: {},
            visibility: GPUShaderStage.FRAGMENT,
          },
          {
            binding: 2,
            buffer: { type: 'uniform' },
            visibility: GPUShaderStage.FRAGMENT,
          },
        ],
      });
      const pipeline = device.createRenderPipeline({
        fragment: {
          entryPoint: 'fragment_main',
          module: device.createShaderModule({ code: SHADER }),
          targets: [{ format }],
        },
        layout: device.createPipelineLayout({
          bindGroupLayouts: [bindGroupLayout],
        }),
        primitive: {
          topology: 'triangle-list',
        },
        vertex: {
          entryPoint: 'vertex_main',
          module: device.createShaderModule({ code: SHADER }),
        },
      });

      const render = () => {
        if (cancelled || !device || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          return;
        }

        resizeCanvas(canvas);
        device.queue.writeBuffer(uniformBuffer, 0, createEffectUniforms(effectsRef.current));

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              clearValue: { a: 1, b: 0, g: 0, r: 0 },
              loadOp: 'clear',
              storeOp: 'store',
              view: context.getCurrentTexture().createView(),
            },
          ],
        });
        const bindGroup = device.createBindGroup({
          entries: [
            {
              binding: 0,
              resource: device.importExternalTexture({ source: video }),
            },
            {
              binding: 1,
              resource: sampler,
            },
            {
              binding: 2,
              resource: {
                buffer: uniformBuffer,
              },
            },
          ],
          layout: bindGroupLayout,
        });

        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(6);
        pass.end();
        device.queue.submit([encoder.finish()]);
      };

      renderRef.current = render;
      setIsGpuPreviewActive(true);
      performanceMonitor.setGpuPreviewActive(true);
      render();

      const scheduleRaf = () => {
        if (cancelled) {
          return;
        }
        if (!video.paused) {
          render();
          rafId = requestAnimationFrame(scheduleRaf);
        } else {
          rafId = null;
        }
      };

      const startRafIfNeeded = () => {
        if (rafId === null && !cancelled) {
          rafId = requestAnimationFrame(scheduleRaf);
        }
      };

      let onPlay: (() => void) | null = null;
      let onPause: (() => void) | null = null;

      if (video.requestVideoFrameCallback) {
        // requestVideoFrameCallback already fires only when a new frame is
        // composited, so there's nothing to gate by play/pause here.
        const onVideoFrame: VideoFrameRequestCallback = () => {
          render();
          videoFrameId = video.requestVideoFrameCallback?.(onVideoFrame) ?? null;
        };

        videoFrameId = video.requestVideoFrameCallback(onVideoFrame);
      } else {
        // Browsers without rVFC fall back to a rAF loop. Stop the loop while
        // paused so we don't keep re-uploading the same frame to the GPU.
        if (!video.paused) {
          rafId = requestAnimationFrame(scheduleRaf);
        }
        onPlay = () => startRafIfNeeded();
        onPause = () => {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          // One last render so the last frame stays visible while paused.
          render();
        };
        video.addEventListener('play', onPlay);
        video.addEventListener('pause', onPause);
      }

      video.addEventListener('seeked', render);
      video.addEventListener('loadeddata', render);
      window.addEventListener('resize', render);

      if ('ResizeObserver' in window) {
        resizeObserver = new ResizeObserver(render);
        resizeObserver.observe(canvas);
      }

      cleanupGpuListeners = () => {
        video.removeEventListener('seeked', render);
        video.removeEventListener('loadeddata', render);
        window.removeEventListener('resize', render);
        if (onPlay) video.removeEventListener('play', onPlay);
        if (onPause) video.removeEventListener('pause', onPause);
        resizeObserver?.disconnect();
      };
    }

    start().catch(() => {
      if (!cancelled) {
        setIsGpuPreviewActive(false);
        performanceMonitor.setGpuPreviewActive(false);
      }
    });

    return () => {
      cancelled = true;
      renderRef.current = null;
      setIsGpuPreviewActive(false);
      performanceMonitor.setGpuPreviewActive(false);

      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }

      if (videoFrameId !== null && video?.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(videoFrameId);
      }

      cleanupGpuListeners?.();
      device?.destroy();
    };
  }, [canvasRef, enabled, videoRef]);

  return { isGpuPreviewActive };
}

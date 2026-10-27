import React, { useEffect, useRef } from 'react';

/**
 * Apple macOS/iOS inspired Dynamic Fluid Light Mesh
 * Pure organic ambient light waves, morphing gradients, and gentle glass refraction.
 * No barcode lines, no sci-fi HUDs, no scanbeams.
 */
export const LoginDynamicBackground: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mouseRef = useRef<{ x: number; y: number; targetX: number; targetY: number }>({
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    mouseRef.current.x = width / 2;
    mouseRef.current.y = height / 2;
    mouseRef.current.targetX = width / 2;
    mouseRef.current.targetY = height / 2;

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);

    const handleMouseMove = (e: MouseEvent) => {
      mouseRef.current.targetX = e.clientX;
      mouseRef.current.targetY = e.clientY;
    };
    window.addEventListener('mousemove', handleMouseMove);

    // Floating fluid light nodes
    const blobs = [
      {
        baseX: 0.25,
        baseY: 0.28,
        radius: 0.38,
        speedX: 0.0006,
        speedY: 0.0008,
        phase: 0,
        // Apple signature sky blue
        colorStart: 'rgba(0, 113, 227, 0.16)',
        colorMid: 'rgba(100, 210, 255, 0.08)',
      },
      {
        baseX: 0.72,
        baseY: 0.35,
        radius: 0.42,
        speedX: -0.0007,
        speedY: 0.0005,
        phase: Math.PI * 0.7,
        // Soft royal violet / indigo
        colorStart: 'rgba(94, 92, 230, 0.12)',
        colorMid: 'rgba(191, 90, 242, 0.05)',
      },
      {
        baseX: 0.5,
        baseY: 0.75,
        radius: 0.45,
        speedX: 0.0005,
        speedY: -0.0006,
        phase: Math.PI * 1.4,
        // Gentle cyan aura
        colorStart: 'rgba(48, 176, 199, 0.12)',
        colorMid: 'rgba(0, 113, 227, 0.05)',
      },
      {
        baseX: 0.8,
        baseY: 0.8,
        radius: 0.35,
        speedX: -0.0005,
        speedY: -0.0007,
        phase: Math.PI * 0.3,
        // Subtle warm luminous blush
        colorStart: 'rgba(175, 82, 222, 0.09)',
        colorMid: 'rgba(0, 113, 227, 0.03)',
      },
    ];

    let t = 0;

    const render = () => {
      t += 1;

      // Mouse smoothing
      mouseRef.current.x += (mouseRef.current.targetX - mouseRef.current.x) * 0.04;
      mouseRef.current.y += (mouseRef.current.targetY - mouseRef.current.y) * 0.04;

      const mouseNormX = (mouseRef.current.x / width - 0.5) * 60;
      const mouseNormY = (mouseRef.current.y / height - 0.5) * 60;

      // Clear with base Apple light tint
      ctx.fillStyle = '#F5F5F7';
      ctx.fillRect(0, 0, width, height);

      // Render organic fluid ambient lights
      for (let i = 0; i < blobs.length; i++) {
        const b = blobs[i];

        // Smooth harmonic orbital drifting
        const currentX =
          width * b.baseX +
          Math.sin(t * b.speedX + b.phase) * (width * 0.14) +
          mouseNormX * (0.8 + i * 0.2);
        const currentY =
          height * b.baseY +
          Math.cos(t * b.speedY + b.phase) * (height * 0.12) +
          mouseNormY * (0.8 + i * 0.2);

        const currentRadius =
          Math.min(width, height) * b.radius * (1 + Math.sin(t * 0.001 + b.phase) * 0.12);

        const grad = ctx.createRadialGradient(
          currentX,
          currentY,
          currentRadius * 0.05,
          currentX,
          currentY,
          currentRadius
        );

        grad.addColorStop(0, b.colorStart);
        grad.addColorStop(0.5, b.colorMid);
        grad.addColorStop(1, 'rgba(245, 245, 247, 0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(currentX, currentY, currentRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Very subtle interactive specular cursor aura
      if (mouseRef.current.x > 0 && mouseRef.current.y > 0) {
        const cursorRadius = Math.min(width, height) * 0.32;
        const cursorGrad = ctx.createRadialGradient(
          mouseRef.current.x,
          mouseRef.current.y,
          0,
          mouseRef.current.x,
          mouseRef.current.y,
          cursorRadius
        );
        cursorGrad.addColorStop(0, 'rgba(0, 113, 227, 0.07)');
        cursorGrad.addColorStop(0.6, 'rgba(100, 210, 255, 0.02)');
        cursorGrad.addColorStop(1, 'rgba(245, 245, 247, 0)');

        ctx.fillStyle = cursorGrad;
        ctx.beginPath();
        ctx.arc(mouseRef.current.x, mouseRef.current.y, cursorRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden select-none">
      {/* Fluid Canvas */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/* Ultra-subtle Apple Studio Dot Matrix Texture (Clean & Minimalist) */}
      <div
        className="absolute inset-0 opacity-[0.45]"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(0, 0, 0, 0.04) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      />
    </div>
  );
};

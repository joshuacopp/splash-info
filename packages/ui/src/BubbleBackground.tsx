// Animated bubble background for the public claim form + landing page.
// Source: legacy/damagemanager.js:502-526 (renderLandingPage / renderDamageForm
// inline CSS). Light-mode background — sits behind a translucent white card.
//
// Usage:
//   <BubbleBackground />
//   <main style={{ position: 'relative', zIndex: 10 }}>...</main>
//
// The CSS keyframes are emitted as a <style> tag the first time the
// component renders (idempotent — duplicate keys are harmless).

import type { CSSProperties } from "react";

const KEYFRAMES = `
@keyframes splash-bubble-rise {
  0%   { bottom: -100px; transform: translateX(0) scale(1); }
  50%  { transform: translateX(100px) scale(1.1); }
  100% { bottom: 110vh; transform: translateX(-100px) scale(0.8); }
}
.splash-bubble {
  position: absolute;
  bottom: -100px;
  background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.8), rgba(255,255,255,0.3));
  border-radius: 50%;
  opacity: 0.6;
  animation: splash-bubble-rise linear infinite;
  box-shadow: inset 0 0 20px rgba(255,255,255,0.5), 0 0 20px rgba(255,255,255,0.3);
  pointer-events: none;
  z-index: 1;
}
.splash-bubble::before {
  content: '';
  position: absolute;
  top: 10%;
  left: 10%;
  width: 40%;
  height: 40%;
  background: radial-gradient(circle, rgba(255,255,255,0.9), transparent);
  border-radius: 50%;
}
`;

const BUBBLES = [
  { left: "10%", size: 60, duration: "8s", delay: "0s" },
  { left: "20%", size: 40, duration: "6s", delay: "1s" },
  { left: "35%", size: 80, duration: "10s", delay: "2s" },
  { left: "50%", size: 50, duration: "7s", delay: "0.5s" },
  { left: "65%", size: 70, duration: "9s", delay: "1.5s" },
  { left: "80%", size: 45, duration: "6.5s", delay: "0.8s" }
] as const;

const wrapperStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "linear-gradient(to bottom, #e0f2fe 0%, #bae6fd 100%)",
  zIndex: 0,
  pointerEvents: "none",
  overflow: "hidden"
};

export function BubbleBackground() {
  return (
    <>
      <style>{KEYFRAMES}</style>
      <div style={wrapperStyle} aria-hidden="true">
        {BUBBLES.map((b, i) => (
          <div
            key={i}
            className="splash-bubble"
            style={{
              left: b.left,
              width: b.size,
              height: b.size,
              animationDuration: b.duration,
              animationDelay: b.delay
            }}
          />
        ))}
      </div>
    </>
  );
}

import { useEffect, useRef, useState } from "react";

// Uses the browser's built-in BarcodeDetector (Chrome/Android, Safari 17+). Falls back to typing the code.
export default function QrScanner({ onCode, onClose }: { onCode: (c: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null); const [msg, setMsg] = useState("");
  useEffect(() => {
    let stream: MediaStream | undefined, stop = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BD = (window as any).BarcodeDetector;
    if (!BD) { setMsg("Scanning isn't supported on this browser. Type the code instead."); return; }
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!video.current) return; video.current.srcObject = stream; await video.current.play();
        const det = new BD({ formats: ["qr_code"] });
        const tick = async () => {
          if (stop || !video.current) return;
          const r = await det.detect(video.current).catch(() => []);
          if (r[0]?.rawValue) { navigator.vibrate?.(30); onCode(String(r[0].rawValue)); return; }
          requestAnimationFrame(tick);
        };
        tick();
      } catch { setMsg("Camera access was blocked. Type the code instead."); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [onCode]);
  return (
    <div className="space-y-2">
      {msg ? <p className="rounded-xl bg-sunken p-4 text-center text-sm text-muted">{msg}</p> :
        <div className="relative overflow-hidden rounded-2xl bg-black"><video ref={video} playsInline muted className="aspect-square w-full object-cover" />
          <div className="pointer-events-none absolute inset-8 rounded-3xl border-2 border-white/80" /></div>}
      <button onClick={onClose} className="w-full text-sm text-muted">Cancel</button>
    </div>
  );
}

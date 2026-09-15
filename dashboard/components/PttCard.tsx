'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Mic, MicOff, Radio, X, RefreshCw } from 'lucide-react';

const PTT_CHANNEL = 'edgeptt';       // shared channel prefix for all users on this instance
const PING_INTERVAL_MS  = 5_000;
const PEER_TIMEOUT_MS   = 18_000;
const MAX_RECONNECT     = 5;

interface PeerConn {
  peerId: string;
  name: string;
  micActive: boolean;
}

type Status = 'connecting' | 'connect' | 'disconnect' | 'reconnecting';

interface Props {
  onClose: () => void;
}

export function PttCard({ onClose }: Props) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const [myName, setMyName] = useState('User');
  const myUserId = useRef(`u${Date.now().toString(36)}`);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.username) { setMyName(d.username); myUserId.current = d.userId || myUserId.current; } })
      .catch(() => {});
  }, []);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [status, setStatus]       = useState<Status>('connecting');
  const [freeCall, setFreeCall]   = useState(false);
  const [isTalking, setIsTalking] = useState(false);
  const [peers, setPeers]         = useState<PeerConn[]>([]);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [timeDisconnect, setTimeDisconnect] = useState('');

  // ── Refs (stable across renders) ─────────────────────────────────────────
  const streamRef      = useRef<MediaStream | null>(null);
  const peerRef        = useRef<any>(null);          // PeerJS Peer instance
  const dataConns      = useRef<Record<string, any>>({});
  const mediaCalls     = useRef<Record<string, any>>({});
  const remoteStreams   = useRef<Record<string, MediaStream>>({});
  const audioEls       = useRef<Record<string, HTMLAudioElement>>({});
  const lastSeen       = useRef<Record<string, number>>({});
  const pingTimer      = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCount = useRef(0);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const animFrameRef   = useRef<number>(0);
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const keysPressed    = useRef(new Set<string>());
  const pttActiveRef   = useRef(false);
  const isMountedRef   = useRef(true);
  const freeCallRef    = useRef(false);

  // keep freeCallRef in sync
  useEffect(() => { freeCallRef.current = freeCall; }, [freeCall]);

  // ── PeerJS Peer ID ────────────────────────────────────────────────────────
  const myPeerIdRef = useRef(
    `${PTT_CHANNEL}-${myUserId.current}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  );

  // ── Audio unlock (mobile autoplay policy) ────────────────────────────────
  const unlockAudio = useCallback(() => {
    setNeedsUnlock(false);
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {});
    Object.values(audioEls.current).forEach(el => el.paused && el.play().catch(() => {}));
  }, []);

  // ── Microphone stream ─────────────────────────────────────────────────────
  async function initStream() {
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      streamRef.current = null;
    }
  }

  // ── mute / unmute ─────────────────────────────────────────────────────────
  function mute() {
    streamRef.current?.getAudioTracks().forEach(t => { t.enabled = false; });
    setIsTalking(false);
    cancelAnimationFrame(animFrameRef.current);
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    broadcastMic('inactive');
  }

  async function unmute() {
    if (!streamRef.current) await initStream();
    if (!streamRef.current) return;
    if (streamRef.current.getAudioTracks().every(t => t.readyState === 'ended')) await initStream();
    streamRef.current?.getAudioTracks().forEach(t => { t.enabled = true; });
    setIsTalking(true);
    startWaveform();
    broadcastMic('active');
  }

  function broadcastMic(micStatus: 'active' | 'inactive') {
    Object.values(dataConns.current).forEach(conn => {
      if (conn?.open) {
        try { conn.send({ type: 'microphone', data: { peerId: myPeerIdRef.current, status: micStatus } }); } catch {}
      }
    });
  }

  // ── Waveform visualisation ────────────────────────────────────────────────
  function startWaveform() {
    if (!streamRef.current) return;
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(streamRef.current);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const canvas = canvasRef.current;
    const cCtx = canvas?.getContext('2d');
    const draw = () => {
      animFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(buf);
      if (!canvas || !cCtx) return;
      const { width: w, height: h } = canvas;
      cCtx.clearRect(0, 0, w, h);
      const barW = w / buf.length;
      buf.forEach((v, i) => {
        const barH = (v / 255) * h;
        cCtx.fillStyle = `hsl(var(--primary) / ${0.4 + (v / 255) * 0.6})`;
        cCtx.fillRect(i * barW, h - barH, barW - 1, barH);
      });
    };
    draw();
  }

  // ── PTT hold-to-talk ──────────────────────────────────────────────────────
  const handleGlobalEnd = useCallback(() => {
    if (!freeCallRef.current) mute();
    window.removeEventListener('mouseup', handleGlobalEnd);
    window.removeEventListener('touchend', handleGlobalEnd);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pushToTalkStart() {
    if (status !== 'connect') return;
    unmute();
    window.addEventListener('mouseup', handleGlobalEnd);
    window.addEventListener('touchend', handleGlobalEnd);
  }

  function pushToTalkEnd() {
    if (!freeCallRef.current) mute();
    window.removeEventListener('mouseup', handleGlobalEnd);
    window.removeEventListener('touchend', handleGlobalEnd);
  }

  // ── Keyboard Ctrl+Space ───────────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      keysPressed.current.add(e.code);
      if (!pttActiveRef.current &&
          (keysPressed.current.has('ControlLeft') || keysPressed.current.has('ControlRight')) &&
          keysPressed.current.has('Space')) {
        pttActiveRef.current = true;
        pushToTalkStart();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      keysPressed.current.delete(e.code);
      if (pttActiveRef.current && (e.code === 'Space' || e.code.startsWith('Control'))) {
        pttActiveRef.current = false;
        pushToTalkEnd();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // ── Peers state helper ────────────────────────────────────────────────────
  function upsertPeer(p: PeerConn) {
    setPeers(prev => {
      const idx = prev.findIndex(x => x.peerId === p.peerId);
      if (idx > -1) { const next = [...prev]; next[idx] = { ...next[idx], ...p }; return next; }
      return [...prev, p];
    });
  }
  function removePeerState(peerId: string) {
    setPeers(prev => prev.filter(x => x.peerId !== peerId));
  }

  // ── PeerJS mesh ───────────────────────────────────────────────────────────
  function setupDataConn(conn: any, isInitiator: boolean) {
    const pId = conn.peer as string;
    dataConns.current[pId] = conn;
    lastSeen.current[pId] = Date.now();

    conn.on('open', () => {
      conn.send({ type: 'intro', data: { peerId: myPeerIdRef.current, name: myName } });
      if (!isInitiator && !mediaCalls.current[pId]) initiateCall(pId);
    });

    conn.on('data', (data: any) => {
      lastSeen.current[pId] = Date.now();
      if (data?.type === 'ping') { try { conn.send({ type: 'pong' }); } catch {} return; }
      if (data?.type === 'pong') return;
      if (data?.type === 'intro' || data?.type === 'intro_ack') {
        upsertPeer({ peerId: pId, name: data.data?.name || pId, micActive: false });
        if (data?.type === 'intro') {
          try { conn.send({ type: 'intro_ack', data: { peerId: myPeerIdRef.current, name: myName } }); } catch {}
        }
      }
      if (data?.type === 'microphone') {
        setPeers(prev => prev.map(p => p.peerId === pId
          ? { ...p, micActive: data.data?.status === 'active' }
          : p));
      }
    });

    conn.on('close', () => removePeer(pId));
    conn.on('error', () => removePeer(pId));
  }

  function initiateCall(targetPeerId: string) {
    if (!peerRef.current || mediaCalls.current[targetPeerId]) return;
    const call = streamRef.current
      ? peerRef.current.call(targetPeerId, streamRef.current)
      : peerRef.current.call(targetPeerId, new MediaStream());
    if (!call) return;
    mediaCalls.current[targetPeerId] = call;
    call.on('stream', (remote: MediaStream) => {
      remoteStreams.current[targetPeerId] = remote;
      const audio = new Audio();
      audio.srcObject = remote;
      audio.autoplay = true;
      audioEls.current[targetPeerId] = audio;
      audio.play().catch(() => setNeedsUnlock(true));
    });
    const end = () => { delete mediaCalls.current[targetPeerId]; delete remoteStreams.current[targetPeerId]; };
    call.on('close', end);
    call.on('error', end);
  }

  function removePeer(pId: string) {
    try { dataConns.current[pId]?.close(); } catch {}
    try { mediaCalls.current[pId]?.close(); } catch {}
    const audio = audioEls.current[pId];
    if (audio) { audio.pause(); audio.srcObject = null; delete audioEls.current[pId]; }
    delete dataConns.current[pId];
    delete mediaCalls.current[pId];
    delete remoteStreams.current[pId];
    delete lastSeen.current[pId];
    removePeerState(pId);
  }

  async function discoverPeers() {
    try {
      const raw: string[] = await fetch('/peerjs/peerjs/peers').then(r => r.json());
      const channelPeers = raw.filter(p => p.startsWith(`${PTT_CHANNEL}-`) && p !== myPeerIdRef.current);
      channelPeers.forEach(pId => {
        if (!dataConns.current[pId] || !dataConns.current[pId].open) {
          const conn = peerRef.current.connect(pId, { reliable: true });
          setupDataConn(conn, true);
        }
        if (!mediaCalls.current[pId]) initiateCall(pId);
      });
    } catch {}
  }

  function startPing() {
    stopPing();
    pingTimer.current = setInterval(() => {
      const now = Date.now();
      Object.entries(dataConns.current).forEach(([pId, conn]) => {
        if (conn?.open) { try { conn.send({ type: 'ping' }); } catch {} }
        if (lastSeen.current[pId] && now - lastSeen.current[pId] > PEER_TIMEOUT_MS) removePeer(pId);
      });
    }, PING_INTERVAL_MS);
  }

  function stopPing() {
    if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }
  }

  function scheduleReconnect() {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (reconnectCount.current >= MAX_RECONNECT) {
      if (isMountedRef.current) setStatus('disconnect');
      return;
    }
    const delay = Math.min(1000 * 2 ** reconnectCount.current, 16000);
    reconnectCount.current++;
    if (isMountedRef.current) setReconnectAttempt(reconnectCount.current);
    reconnectTimer.current = setTimeout(() => {
      if (!peerRef.current || peerRef.current.destroyed) { initPeer(); return; }
      try { peerRef.current.reconnect(); } catch { peerRef.current.destroy(); initPeer(); }
    }, delay);
  }

  function manualReconnect() {
    reconnectCount.current = 0;
    setReconnectAttempt(0);
    setStatus('reconnecting');
    if (peerRef.current && !peerRef.current.destroyed) {
      try { peerRef.current.reconnect(); } catch { peerRef.current.destroy(); initPeer(); }
    } else {
      initPeer();
    }
  }

  async function initPeer() {
    if (!isMountedRef.current) return;
    if (isMountedRef.current) setStatus('connecting');

    const { Peer } = await import('peerjs');
    const proto = window.location.protocol === 'https:' ? 'https' : 'http';
    const isSecure = proto === 'https';
    const peerPort = parseInt(window.location.port) || (isSecure ? 443 : 80);

    const peer = new Peer(myPeerIdRef.current, {
      host: window.location.hostname,
      port: peerPort,
      path: '/peerjs',
      secure: isSecure,
      key: 'peerjs',
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      },
    });

    peerRef.current = peer;

    peer.on('open', async () => {
      if (!isMountedRef.current) return;
      setStatus('connect');
      reconnectCount.current = 0;
      setReconnectAttempt(0);
      await discoverPeers();
      startPing();
    });

    peer.on('connection', (conn) => setupDataConn(conn, false));

    peer.on('call', (call) => {
      mediaCalls.current[call.peer] = call;
      call.answer(streamRef.current || new MediaStream());
      call.on('stream', (remote: MediaStream) => {
        remoteStreams.current[call.peer] = remote;
        const audio = new Audio();
        audio.srcObject = remote;
        audio.autoplay = true;
        audioEls.current[call.peer] = audio;
        audio.play().catch(() => setNeedsUnlock(true));
      });
      const end = () => { delete mediaCalls.current[call.peer]; delete remoteStreams.current[call.peer]; };
      call.on('close', end);
      call.on('error', end);
    });

    peer.on('disconnected', () => {
      if (!isMountedRef.current) return;
      setStatus('reconnecting');
      setTimeDisconnect(new Date().toLocaleTimeString());
      stopPing();
      scheduleReconnect();
    });

    peer.on('error', (err: any) => {
      console.warn('[PTT]', err?.type, err?.message);
      if (err?.type === 'unavailable-id') {
        // regenerate peer ID and retry
        myPeerIdRef.current = `${PTT_CHANNEL}-${myUserId.current}-${Date.now().toString(36)}`;
        peer.destroy();
        setTimeout(initPeer, 500);
      }
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    isMountedRef.current = true;
    initStream().then(initPeer);

    window.addEventListener('click', unlockAudio);
    window.addEventListener('touchstart', unlockAudio);

    return () => {
      isMountedRef.current = false;
      stopPing();
      cancelAnimationFrame(animFrameRef.current);
      if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); }
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      window.removeEventListener('mouseup', handleGlobalEnd);
      window.removeEventListener('touchend', handleGlobalEnd);
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
      Object.keys(dataConns.current).forEach(pId => removePeer(pId));
      peerRef.current?.destroy();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Toggle free-call mode ─────────────────────────────────────────────────
  function toggleFreeCall() {
    const next = !freeCall;
    setFreeCall(next);
    if (next) unmute(); else mute();
  }

  // ── Pointer handlers for hold-to-talk button ──────────────────────────────
  function onPointerDown(e: React.PointerEvent) {
    if (freeCall) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pushToTalkStart();
  }
  function onPointerUp() { if (!freeCall) pushToTalkEnd(); }

  // ── Status colours / labels ───────────────────────────────────────────────
  const STATUS_DOT: Record<Status, string> = {
    connecting:   'bg-yellow-500 animate-pulse',
    connect:      'bg-emerald-500',
    disconnect:   'bg-destructive',
    reconnecting: 'bg-yellow-500 animate-pulse',
  };
  const STATUS_LABEL: Record<Status, string> = {
    connecting:   'Connecting…',
    connect:      'Connected',
    disconnect:   `Disconnected${timeDisconnect ? ` at ${timeDisconnect}` : ''}`,
    reconnecting: `Reconnecting… (${reconnectAttempt}/${MAX_RECONNECT})`,
  };

  const canTalk = status === 'connect';

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-border bg-background shadow-2xl overflow-hidden flex flex-col">

      {/* Audio unlock banner */}
      {needsUnlock && (
        <button
          onClick={unlockAudio}
          className="w-full bg-amber-500 text-white text-xs font-medium px-4 py-2 flex items-center justify-center gap-2"
        >
          <span>🔊</span> Tap to enable group audio
        </button>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">Push to Talk</span>
        </div>
        <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Status bar */}
      {(status === 'disconnect' || status === 'reconnecting') && (
        <div className="flex items-center gap-2 px-4 py-2 bg-destructive/10 border-b border-border text-xs">
          <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[status]}`} />
          <span className="flex-1 text-destructive font-medium truncate">{STATUS_LABEL[status]}</span>
          {status === 'disconnect' && (
            <button onClick={manualReconnect} className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-primary text-primary-foreground text-xs">
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          )}
        </div>
      )}

      {/* Waveform */}
      <canvas
        ref={canvasRef}
        width={320}
        height={36}
        className={`w-full transition-opacity duration-200 ${isTalking ? 'opacity-100' : 'opacity-0'}`}
      />

      {/* Big PTT button */}
      <div className="flex flex-col items-center py-5 gap-4">
        <button
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          disabled={!canTalk}
          className={[
            'relative w-20 h-20 rounded-full flex items-center justify-center transition-all select-none touch-none',
            isTalking && canTalk
              ? 'bg-primary text-primary-foreground scale-105 shadow-lg shadow-primary/40'
              : canTalk
              ? 'bg-muted text-foreground hover:bg-muted/70 active:scale-95'
              : 'bg-muted text-muted-foreground opacity-50 cursor-not-allowed',
          ].join(' ')}
        >
          {isTalking && <span className="absolute inset-0 rounded-full animate-ping bg-primary/30 pointer-events-none" />}
          {canTalk ? <Mic className="w-8 h-8" /> : <MicOff className="w-8 h-8" />}
        </button>

        <p className={`text-xs font-medium ${isTalking ? 'text-primary' : 'text-muted-foreground'}`}>
          {!canTalk ? STATUS_LABEL[status]
            : freeCall ? (isTalking ? 'Transmitting (free)' : 'Mic on — free call')
            : isTalking ? 'Transmitting…'
            : 'Hold to talk  ·  Ctrl+Space'}
        </p>
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-2 px-4 pb-4 justify-center">
        <button
          onClick={toggleFreeCall}
          disabled={!canTalk}
          title={freeCall ? 'Disable free call' : 'Enable free call (always-on mic)'}
          className={[
            'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
            freeCall
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
            !canTalk ? 'opacity-40 cursor-not-allowed' : '',
          ].join(' ')}
        >
          <Mic className="w-3 h-3" />
          Free Call
        </button>
      </div>

      {/* Connected peers */}
      {peers.length > 0 && (
        <div className="border-t border-border px-4 py-3 space-y-1.5">
          <p className="text-xs text-muted-foreground font-medium">On channel ({peers.length})</p>
          {peers.map(p => (
            <div key={p.peerId} className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full shrink-0 transition-colors ${p.micActive ? 'bg-primary animate-pulse' : 'bg-muted-foreground/40'}`} />
              <span className="text-xs truncate">{p.name}</span>
              {p.micActive && <span className="ml-auto text-xs text-primary font-medium shrink-0">speaking</span>}
            </div>
          ))}
        </div>
      )}

      {/* Connection status footer */}
      <div className="flex items-center gap-2 px-4 py-2 border-t border-border bg-muted/20">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[status]}`} />
        <p className="text-xs text-muted-foreground truncate">{STATUS_LABEL[status]}</p>
        {peers.length === 0 && status === 'connect' && (
          <span className="ml-auto text-xs text-muted-foreground shrink-0">waiting for others…</span>
        )}
      </div>
    </div>
  );
}

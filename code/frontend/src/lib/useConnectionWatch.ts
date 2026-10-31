// One watcher per call. Disposal suppresses intentional close events and stale grace timers.
// onDisconnected fires even if the call recovers within the grace: words said meanwhile leave no event.
export function watchConnection(pc: RTCPeerConnection, dc: RTCDataChannel, onLoss: () => void, onDisconnected: () => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const fail = () => {
    if (stopped) return;
    dispose();
    onLoss();
  };
  const changed = () => {
    if (stopped) return;
    if (pc.connectionState === "failed" || pc.connectionState === "closed") fail();
    else if (pc.connectionState === "disconnected") {
      onDisconnected();
      timer ??= setTimeout(fail, 5_000);
    } else if (pc.connectionState === "connected") clear();
  };
  function dispose() {
    stopped = true;
    clear();
    pc.removeEventListener("connectionstatechange", changed);
    dc.removeEventListener("close", fail);
    dc.removeEventListener("error", fail);
  }
  pc.addEventListener("connectionstatechange", changed);
  dc.addEventListener("close", fail);
  dc.addEventListener("error", fail);
  changed();
  if (dc.readyState === "closed") fail();
  return dispose;
}

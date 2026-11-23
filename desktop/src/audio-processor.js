// BridgeCam Audio Worklet Processor
//
// Lives in the AudioWorkletGlobalScope — cannot access DOM or main-thread APIs.
// process() is called once per 128-sample quantum (128/48000 ≈ 2.67ms at 48kHz).
//
// Pipeline:
//   WebRTC audio track → MediaStreamAudioSourceNode → AudioWorkletNode
//   → process() interleaves stereo f32 PCM → postMessage to main thread
//   → main thread sends ArrayBuffer over WebSocket to Rust audio_socket
//   → Rust writes PCM to VB-Audio Cable Input via WASAPI (cpal)
//
// Audio format sent over WebSocket: raw f32le, interleaved stereo, 48000 Hz.
// Each message = 128 samples × 2 channels × 4 bytes = 1024 bytes.

class BridgeCamAudioProcessor extends AudioWorkletProcessor {
  process (inputs) {
    const input = inputs[0]
    if (!input || !input[0] || input[0].length === 0) return true

    const L = input[0]
    const R = input[1] || input[0]  // fall back to mono duplicated as stereo

    // Interleave L/R into a single buffer (f32le stereo)
    const interleaved = new Float32Array(L.length * 2)
    for (let i = 0; i < L.length; i++) {
      interleaved[i * 2]     = L[i]
      interleaved[i * 2 + 1] = R[i]
    }

    // Transfer (zero-copy) to main thread — main thread owns the buffer after this
    this.port.postMessage(interleaved.buffer, [interleaved.buffer])
    return true  // keep processor alive
  }
}

registerProcessor('bridgecam-audio', BridgeCamAudioProcessor)

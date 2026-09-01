declare module 'onnxruntime-node' {
  export interface InferenceSession {
    run(
      feeds: Record<string, { data: Float32Array | Int32Array | Uint8Array; dims: number[] }>,
    ): Promise<{
      last_hidden_state?: { data: Float32Array };
      pooler_output?: { data: Float32Array };
    }>;
  }

  const ONNX: {
    InferenceSession: new (path: string) => InferenceSession;
  };

  export default ONNX;
}

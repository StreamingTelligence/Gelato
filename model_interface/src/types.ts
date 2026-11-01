/** Controller-facing model input, independent of any provider or device driver. */
export type ModelPart = { type: "text"; text: string }
  | { type: "media"; mimeType: string; dataBase64: string };

export interface ModelRequest {
  deviceId: string;
  messageId: string;
  parts: ModelPart[];
}

export interface ModelEndpoint {
  generate(input: ModelRequest, options?: { onDelta?: (text: string) => void }): Promise<string>;
  close?(): void;
}

// One-time setup: downloads the all-MiniLM-L6-v2 quantized ONNX weights into
// src/embeddings/models/ so they ship with the deployment instead of being
// downloaded at runtime (see README, "Embedding model cold-start"). Re-run
// this if the committed model files are ever deleted or the model changes.
import path from "node:path";
import { pipeline, env } from "@xenova/transformers";

const MODELS_DIR = path.join(process.cwd(), "src/embeddings/models");
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

async function main() {
  env.cacheDir = MODELS_DIR;
  env.allowRemoteModels = true;
  console.log(`Downloading ${MODEL_ID} into ${MODELS_DIR} ...`);
  await pipeline("feature-extraction", MODEL_ID);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

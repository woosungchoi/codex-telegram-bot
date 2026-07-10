import fs from "node:fs/promises";
import path from "node:path";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

let atomicWriteCounter = 0;

export async function ensurePrivateDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.chmod(dirPath, PRIVATE_DIR_MODE);
}

export async function writePrivateFile(filePath, data, options) {
  await ensurePrivateDirectory(path.dirname(filePath));
  const handle = await fs.open(filePath, "w", PRIVATE_FILE_MODE);
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(data, options);
  } finally {
    await handle.close();
  }
}

export async function appendPrivateFile(filePath, data, options) {
  await ensurePrivateDirectory(path.dirname(filePath));
  const handle = await fs.open(filePath, "a", PRIVATE_FILE_MODE);
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(data, options);
  } finally {
    await handle.close();
  }
}

export async function writePrivateFileAtomic(filePath, data) {
  await ensurePrivateDirectory(path.dirname(filePath));
  atomicWriteCounter = (atomicWriteCounter + 1) % Number.MAX_SAFE_INTEGER;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${atomicWriteCounter}.tmp`;
  let handle;
  let renamed = false;
  try {
    handle = await fs.open(tmpPath, "wx", PRIVATE_FILE_MODE);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(data);
    await handle.close();
    handle = null;
    await fs.rename(tmpPath, filePath);
    renamed = true;
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

export async function hardenPrivateTree(rootPath) {
  const unexpected = [];
  await hardenPath(rootPath, unexpected);
  return unexpected;
}

async function hardenPath(filePath, unexpected) {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.chmod(filePath, PRIVATE_DIR_MODE);
    const entries = await fs.readdir(filePath, { withFileTypes: true });
    for (const entry of entries) {
      await hardenPath(path.join(filePath, entry.name), unexpected);
    }
    return;
  }
  if (stat.isFile() || stat.isSocket()) {
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
    return;
  }
  unexpected.push({ path: filePath, type: specialFileType(stat) });
}

function specialFileType(stat) {
  if (stat.isBlockDevice()) return "block-device";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isFIFO()) return "fifo";
  return "unknown";
}

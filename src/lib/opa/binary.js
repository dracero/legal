import fs from 'fs';
import path from 'path';
import os from 'os';

const OPA_VERSION = 'v1.22.0';

function getBinaryFileName() {
  return process.platform === 'win32' ? 'opa.exe' : 'opa';
}

function getAppOpaPath() {
  return path.resolve(process.cwd(), 'bin', getBinaryFileName());
}

/**
 * Resuelve la ruta al binario ejecutable de OPA priorizando el directorio de la aplicación (./bin/opa).
 */
export function resolveOpaBinary() {
  const configured = process.env.OPA_BIN_PATH?.trim();
  if (configured) {
    if (configured === 'opa' || configured === 'opa.exe') {
      return configured;
    }
    const resolvedConfigured = path.resolve(process.cwd(), configured);
    if (fs.existsSync(resolvedConfigured)) {
      return resolvedConfigured;
    }
  }

  const appBinOpa = getAppOpaPath();
  if (fs.existsSync(appBinOpa)) {
    return appBinOpa;
  }

  const rootOpa = path.resolve(process.cwd(), getBinaryFileName());
  if (fs.existsSync(rootOpa)) {
    return rootOpa;
  }

  const legacyUserOpa = path.join(os.homedir(), '.local', 'bin', getBinaryFileName());
  if (fs.existsSync(legacyUserOpa)) {
    return legacyUserOpa;
  }

  return getBinaryFileName();
}

/**
 * Asegura que el binario de OPA exista dentro del directorio ./bin de la aplicación.
 * Si falta (ej. en un clon nuevo), lo copia desde ~/.local/bin o descarga la versión oficial.
 */
export async function ensureAppOpaBinary() {
  const targetPath = getAppOpaPath();
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const legacyUserOpa = path.join(os.homedir(), '.local', 'bin', getBinaryFileName());
  if (fs.existsSync(legacyUserOpa)) {
    fs.copyFileSync(legacyUserOpa, targetPath);
    if (process.platform !== 'win32') {
      fs.chmodSync(targetPath, 0o755);
    }
    console.log(`[OPA] Binario copiado al directorio de la aplicación: ${targetPath}`);
    return targetPath;
  }

  let asset = 'opa_linux_amd64_static';
  if (process.platform === 'linux' && process.arch === 'arm64') {
    asset = 'opa_linux_arm64_static';
  } else if (process.platform === 'darwin') {
    asset = process.arch === 'arm64' ? 'opa_darwin_arm64_static' : 'opa_darwin_amd64';
  } else if (process.platform === 'win32') {
    asset = 'opa_windows_amd64.exe';
  }

  const downloadUrl = `https://openpolicyagent.org/downloads/${OPA_VERSION}/${asset}`;
  console.log(`[OPA] Descargando binario ${OPA_VERSION} en directorio de la aplicación (${targetPath})...`);
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(`No se pudo descargar OPA desde ${downloadUrl} (HTTP ${res.status})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(targetPath, buffer);
  if (process.platform !== 'win32') {
    fs.chmodSync(targetPath, 0o755);
  }
  console.log(`[OPA] ✓ Binario instalado localmente en ${targetPath}`);
  return targetPath;
}


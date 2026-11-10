import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

export interface GeminiKeyStatus {
  key: string;
  masked: string;
  status: 'ACTIVE' | 'EXHAUSTED' | 'RATE_LIMITED' | 'INVALID';
  retryAfter: number | null; // Timestamp ms
  successCount: number;
  failCount: number;
  lastUsed: number;
  lastError: string | null;
}

export class GeminiKeyRotator {
  private keyPool: Map<string, GeminiKeyStatus> = new Map();
  private roundRobinIndex = 0;
  private lastEnvCheck = 0;

  constructor() {
    this.refreshKeysFromEnv();
  }

  /**
   * Enmascara una clave para logs seguros: ej. 'AQ.Ab8...ecxvJg'
   */
  public static maskKey(key: string): string {
    if (!key) return '(vacía)';
    if (key.length <= 12) return '***';
    return `${key.slice(0, 6)}...${key.slice(-6)}`;
  }

  /**
   * Lee y sincroniza claves directamente desde .env (autoridad en disco) y process.env.
   * Si el usuario edita o reemplaza claves en .env, actualiza el pool sin reiniciar el servidor.
   */
  public refreshKeysFromEnv(): void {
    const rawKeys: string[] = [];
    let loadedFromEnvFile = false;

    // 1. Recargar archivo .env en disco si existe (prioridad para detectar cambios en caliente)
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const parsed = dotenv.parse(envContent);
        if (parsed.GEMINI_API_KEY) {
          rawKeys.push(parsed.GEMINI_API_KEY);
          loadedFromEnvFile = true;
        }
        if (parsed.GEMINI_API_KEYS) {
          rawKeys.push(parsed.GEMINI_API_KEYS);
          loadedFromEnvFile = true;
        }
        if (parsed.GOOGLE_API_KEY) {
          rawKeys.push(parsed.GOOGLE_API_KEY);
          loadedFromEnvFile = true;
        }
        if (parsed.GOOGLE_API_KEYS) {
          rawKeys.push(parsed.GOOGLE_API_KEYS);
          loadedFromEnvFile = true;
        }
        for (const [k, v] of Object.entries(parsed)) {
          if (/^GEMINI_API_KEY_\d+$/i.test(k) && v) {
            rawKeys.push(v);
            loadedFromEnvFile = true;
          }
        }
      }
    } catch {}

    // 2. Fallback a process.env solo si .env en disco no definió claves
    if (!loadedFromEnvFile) {
      if (process.env.GEMINI_API_KEY) rawKeys.push(process.env.GEMINI_API_KEY);
      if (process.env.GEMINI_API_KEYS) rawKeys.push(process.env.GEMINI_API_KEYS);
      if (process.env.GOOGLE_API_KEY) rawKeys.push(process.env.GOOGLE_API_KEY);
      if (process.env.GOOGLE_API_KEYS) rawKeys.push(process.env.GOOGLE_API_KEYS);

      for (const [k, v] of Object.entries(process.env)) {
        if (/^GEMINI_API_KEY_\d+$/i.test(k) && v) {
          rawKeys.push(v);
        }
      }
    }

    // 3. Separar por comas, puntos y comas, o saltos de línea
    const extractedKeys: string[] = [];
    for (const raw of rawKeys) {
      const parts = raw.split(/[\r\n,;]+/);
      for (const p of parts) {
        const clean = p.trim().replace(/^["']|["']$/g, '');
        if (clean.length > 10 && !extractedKeys.includes(clean)) {
          extractedKeys.push(clean);
        }
      }
    }

    // 4. Eliminar claves que el usuario quitó de .env y agregar/preservar las vigentes
    for (const existingKey of Array.from(this.keyPool.keys())) {
      if (!extractedKeys.includes(existingKey)) {
        this.keyPool.delete(existingKey);
      }
    }

    const now = Date.now();
    for (const key of extractedKeys) {
      if (!this.keyPool.has(key)) {
        this.keyPool.set(key, {
          key,
          masked: GeminiKeyRotator.maskKey(key),
          status: 'ACTIVE',
          retryAfter: null,
          successCount: 0,
          failCount: 0,
          lastUsed: 0,
          lastError: null,
        });
      }
    }

    this.lastEnvCheck = now;
  }

  /**
   * Obtiene todas las claves configuradas (activas o en cooldown)
   */
  public getAllKeys(forceRefresh = false): GeminiKeyStatus[] {
    if (forceRefresh || Date.now() - this.lastEnvCheck > 15000) {
      this.refreshKeysFromEnv();
    }
    return Array.from(this.keyPool.values());
  }

  /**
   * Obtiene las claves actualmente disponibles para operar (rehabilitando las que cumplieron cooldown)
   */
  public getAvailableKeys(forceRefresh = false): GeminiKeyStatus[] {
    const all = this.getAllKeys(forceRefresh);
    const now = Date.now();

    return all.filter((entry) => {
      if (entry.status === 'ACTIVE') return true;
      if (entry.retryAfter && now >= entry.retryAfter) {
        entry.status = 'ACTIVE';
        entry.retryAfter = null;
        entry.lastError = null;
        console.log(`[Gemini Rotator] Clave ${entry.masked} rehabilitada tras finalizar cooldown.`);
        return true;
      }
      return false;
    });
  }

  /**
   * Obtiene la siguiente clave activa mediante Round-Robin
   */
  public getNextActiveKey(): GeminiKeyStatus {
    const available = this.getAvailableKeys();
    if (available.length === 0) {
      const total = this.getAllKeys(true);
      if (total.length === 0) {
        throw new Error(
          'No hay ninguna clave de Gemini configurada. Configure GEMINI_API_KEY en el archivo .env.'
        );
      }

      const details = total
        .map((k) => {
          const remainingMs = k.retryAfter ? Math.max(0, k.retryAfter - Date.now()) : 0;
          const waitLabel =
            remainingMs >= 60000
              ? `espera aprox. ${Math.ceil(remainingMs / 60000)} min`
              : `espera ${Math.ceil(remainingMs / 1000)} seg`;
          return `${k.masked}: ${k.status} (${waitLabel})`;
        })
        .join(', ');

      throw new Error(
        `Todas las claves API de Gemini (${total.length} configuradas) han agotado su cuota o están en cooldown temporal. [${details}]. Ingrese una nueva clave API en .env para continuar de inmediato.`
      );
    }

    const item = available[this.roundRobinIndex % available.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % available.length;
    item.lastUsed = Date.now();
    return item;
  }

  private extractRetryDelaySeconds(errorMsg: string): number | null {
    const jsonMatch = errorMsg.match(/retryDelay["']?:\s*["']?([\d.]+)s/i);
    if (jsonMatch && jsonMatch[1]) {
      return Math.ceil(parseFloat(jsonMatch[1]));
    }
    const textMatch = errorMsg.match(/retry in\s+([\d.]+)s/i);
    if (textMatch && textMatch[1]) {
      return Math.ceil(parseFloat(textMatch[1]));
    }
    return null;
  }

  /**
   * Marca una clave como agotada por cuota diaria (RPD / RESOURCE_EXHAUSTED)
   */
  public markExhausted(key: string, errorMsg: string, defaultCooldownMs = 60 * 60 * 1000): void {
    const entry = this.keyPool.get(key);
    if (!entry) return;

    entry.status = 'EXHAUSTED';
    entry.failCount++;
    entry.lastError = errorMsg;

    const retrySec = this.extractRetryDelaySeconds(errorMsg);
    const retryDuration = retrySec !== null ? (retrySec + 10) * 1000 : defaultCooldownMs;

    entry.retryAfter = Date.now() + retryDuration;
    console.warn(
      `[Gemini Rotator] ⚠️ Clave ${entry.masked} agotó su cuota (RESOURCE_EXHAUSTED). Entrando en cooldown de ${Math.max(1, Math.round(retryDuration / 60000))}m.`
    );
  }

  /**
   * Marca una clave con limitación transitoria por minuto (RPM)
   */
  public markRateLimited(key: string, errorMsg: string, cooldownSec = 20): void {
    const entry = this.keyPool.get(key);
    if (!entry) return;

    entry.status = 'RATE_LIMITED';
    entry.failCount++;
    entry.lastError = errorMsg;
    entry.retryAfter = Date.now() + cooldownSec * 1000;
    console.warn(
      `[Gemini Rotator] ⏳ Clave ${entry.masked} con limitación transitoria. Pausada por ${cooldownSec}s.`
    );
  }

  /**
   * Marca éxito en la invocación de una clave
   */
  public markSuccess(key: string): void {
    const entry = this.keyPool.get(key);
    if (entry) {
      entry.status = 'ACTIVE';
      entry.successCount++;
      entry.retryAfter = null;
      entry.lastError = null;
    }
  }

  /**
   * Ejecuta una llamada a Gemini rotando automáticamente de clave ante errores de cuota o rate-limit,
   * y aplicando backoff inteligente sin bloquear la última clave ante errores 503 de demanda global.
   */
  public async executeWithRotation<T>(
    operation: (client: GoogleGenAI, key: string, masked: string) => Promise<T>,
    operationName = 'Invocación Gemini'
  ): Promise<T> {
    const totalKeys = this.getAllKeys(true);
    if (totalKeys.length === 0) {
      throw new Error(
        'Falta configurar GEMINI_API_KEY en el archivo .env para ejecutar llamadas a Gemini.'
      );
    }

    const maxAttempts = Math.max(totalKeys.length * 4, 6);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Si no hay claves activas inmediatamente, revisar si hay claves RATE_LIMITED de corta espera (<= 65s)
      let available = this.getAvailableKeys(attempt === 1);
      if (available.length === 0) {
        available = this.getAvailableKeys(true);
      }

      if (available.length === 0) {
        const shortCooldownKey = this.getAllKeys()
          .filter((k) => k.status === 'RATE_LIMITED' && k.retryAfter)
          .sort((a, b) => (a.retryAfter || 0) - (b.retryAfter || 0))[0];

        if (shortCooldownKey && shortCooldownKey.retryAfter) {
          const waitMs = shortCooldownKey.retryAfter - Date.now();
          if (waitMs > 0 && waitMs <= 65000) {
            const waitSec = Math.ceil(waitMs / 1000);
            console.warn(
              `[Gemini Rotator] ⏳ Esperando ${waitSec}s para reactivar clave ${shortCooldownKey.masked} (límite RPM temporal)...`
            );
            await new Promise((resolve) => setTimeout(resolve, waitMs + 500));
            available = this.getAvailableKeys();
          }
        }
      }

      let keyEntry: GeminiKeyStatus;
      try {
        keyEntry = this.getNextActiveKey();
      } catch (err: any) {
        throw new Error(
          `[Gemini Rotator] No hay claves disponibles para '${operationName}': ${err.message}`
        );
      }

      const client = new GoogleGenAI({ apiKey: keyEntry.key });

      try {
        const result = await operation(client, keyEntry.key, keyEntry.masked);
        this.markSuccess(keyEntry.key);
        return result;
      } catch (err: any) {
        const errMsg = String(err.message || err);
        const errStatus = err.status || err.code;

        const retrySec = this.extractRetryDelaySeconds(errMsg);
        const is429 =
          errStatus === 429 ||
          errMsg.includes('RESOURCE_EXHAUSTED') ||
          errMsg.includes('Quota exceeded') ||
          errMsg.includes('exceeded your current quota');

        const isDailyQuota =
          is429 &&
          (errMsg.includes('PerDay') ||
            errMsg.includes('requests per day') ||
            errMsg.includes('FreeTier') ||
            (retrySec !== null && retrySec > 120));

        const isTransientOverload =
          errStatus === 503 ||
          errStatus === 500 ||
          errMsg.includes('503') ||
          errMsg.includes('high demand') ||
          errMsg.includes('UNAVAILABLE') ||
          errMsg.includes('overloaded') ||
          errMsg.includes('fetch failed') ||
          errMsg.includes('ECONNRESET') ||
          errMsg.includes('ETIMEDOUT');

        if (isDailyQuota) {
          this.markExhausted(keyEntry.key, errMsg);
          const remaining = this.getAvailableKeys();
          if (remaining.length > 0) {
            console.log(
              `[Gemini Rotator] Rotando inmediatamente a la siguiente clave disponible (${remaining.length} restantes)...`
            );
          }
          continue;
        }

        if (is429) {
          // Límite de frecuencia por minuto (RPM): cooldown corto y rotación o espera
          const cooldown = retrySec && retrySec > 0 && retrySec <= 60 ? retrySec + 2 : 18;
          const otherActiveKeys = this.getAvailableKeys().filter((k) => k.key !== keyEntry.key);
          this.markRateLimited(keyEntry.key, errMsg, cooldown);
          if (otherActiveKeys.length > 0) {
            console.log(
              `[Gemini Rotator] Rotando a clave alternativa tras límite RPM (${otherActiveKeys.length} activas)...`
            );
          }
          continue;
        }

        if (isTransientOverload) {
          // Falla temporal del servidor de Google (503 / high demand):
          // Solo pausar esta clave si existen OTRAS claves activas; si es la única activa, NO bloquearla!
          const otherActiveKeys = this.getAvailableKeys().filter((k) => k.key !== keyEntry.key);
          if (otherActiveKeys.length > 0) {
            this.markRateLimited(keyEntry.key, errMsg, 15);
            console.log(
              `[Gemini Rotator] Alta demanda en clave ${keyEntry.masked}. Rotando a clave alternativa...`
            );
            continue;
          }

          if (attempt < maxAttempts) {
            const backoffMs = Math.min(attempt * 3000, 12000);
            console.warn(
              `[Gemini Rotator] Alta demanda global de Gemini (503). Reintentando con clave ${keyEntry.masked} en ${backoffMs / 1000}s (intento ${attempt}/${maxAttempts})...`
            );
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
        }

        // Error de esquema, prompt o no recuperable
        throw err;
      }
    }

    throw new Error(
      `[Gemini Rotator] Se agotaron los reintentos (${maxAttempts}) para '${operationName}'.`
    );
  }
}

// Instancia singleton para toda la aplicación
export const geminiRotator = new GeminiKeyRotator();

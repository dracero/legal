import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

function resolveOpaBin() {
  if (process.env.OPA_BIN_PATH && process.env.OPA_BIN_PATH.trim() !== '') {
    return process.env.OPA_BIN_PATH.trim();
  }
  const userOpa = path.join(os.homedir(), '.local', 'bin', 'opa');
  if (fs.existsSync(userOpa)) return userOpa;
  return 'opa';
}

const opaBin = resolveOpaBin();
const policyDir = path.resolve(process.env.OPA_POLICY_DIR || './src/lib/opa/policies');

execFileSync(opaBin, ['test', policyDir, '-v'], { stdio: 'inherit' });


import { execFileSync } from 'child_process';
import path from 'path';
import dotenv from 'dotenv';
import { ensureAppOpaBinary, resolveOpaBinary } from '../src/lib/opa/binary.js';

dotenv.config();

await ensureAppOpaBinary();
const opaBin = resolveOpaBinary();
const policyDir = path.resolve(process.env.OPA_POLICY_DIR || './src/lib/opa/policies');

execFileSync(opaBin, ['test', policyDir, '-v'], { stdio: 'inherit' });

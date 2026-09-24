import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(path.join(path.resolve(process.argv[2]),'package.json'));
try {
  for(const name of JSON.parse(process.argv[3]))require.resolve(name);
} catch {process.exitCode=1;}

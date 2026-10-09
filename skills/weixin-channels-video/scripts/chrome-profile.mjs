import { lstat, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function defaultChromeUserDataDir() {
  if (process.platform !== 'darwin') throw new Error('Chrome profile access currently supports macOS only.');
  return join(homedir(), 'Library/Application Support/Google/Chrome');
}

export async function listChromeProfiles(userDataDir = defaultChromeUserDataDir()) {
  let state;
  try {
    state = JSON.parse(await readFile(join(userDataDir, 'Local State'), 'utf8'));
  } catch {
    throw new Error('Chrome profile metadata is unavailable or invalid.');
  }

  const info = state.profile?.info_cache;
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('Chrome profile metadata is unavailable or invalid.');
  const profiles = [];
  for (const [directory, details] of Object.entries(info)) {
    if (
      directory === '.' || directory === '..' || isAbsolute(directory) ||
      directory.includes('/') || directory.includes('\\')
    ) continue;
    try {
      const profileInfo = await lstat(join(userDataDir, directory));
      if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    profiles.push({ directory, name: typeof details?.name === 'string' ? details.name : directory });
  }
  return profiles;
}

export async function selectChromeProfile(reference, userDataDir = defaultChromeUserDataDir()) {
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new Error('Choose a Chrome profile with --profile.');
  }
  const profiles = await listChromeProfiles(userDataDir);
  const byDirectory = profiles.find((profile) => profile.directory === reference);
  const byName = profiles.filter((profile) => profile.name === reference);
  const selected = byDirectory ?? (byName.length === 1 ? byName[0] : undefined);
  if (!selected) {
    throw new Error(byName.length > 1
      ? 'That profile name is ambiguous; use its directory name.'
      : 'The requested Chrome profile was not found.');
  }
  if (
    selected.directory === '.' ||
    selected.directory === '..' ||
    selected.directory.includes('/') ||
    selected.directory.includes('\\')
  ) {
    throw new Error('The selected Chrome profile directory is invalid.');
  }
  return {
    ...selected,
    profileDirectory: join(userDataDir, selected.directory),
  };
}

async function cookieDatabase(profileDir) {
  for (const path of [join(profileDir, 'Network', 'Cookies'), join(profileDir, 'Cookies')]) {
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      // Check the legacy location next.
    }
  }
  throw new Error('The selected Chrome profile has no readable cookie database.');
}

export async function resolveChromeProfile(reference, userDataDir) {
  const root = userDataDir ?? defaultChromeUserDataDir();
  if (reference) {
    const expanded = reference.startsWith('~/') ? join(homedir(), reference.slice(2)) : reference;
    if (isAbsolute(expanded) || expanded.startsWith('./') || expanded.startsWith('../')) {
      const profileDir = resolve(expanded);
      try {
        if (!(await stat(profileDir)).isDirectory()) throw new Error();
      } catch {
        throw new Error('The requested Chrome profile directory does not exist.');
      }
      return { directory: profileDir, name: profileDir, cookieDb: await cookieDatabase(profileDir) };
    }
  }

  const profiles = await listChromeProfiles(root);
  let selected;
  if (reference) {
    const byDirectory = profiles.find((profile) => profile.directory === reference);
    const byName = profiles.filter((profile) => profile.name === reference);
    selected = byDirectory ?? (byName.length === 1 ? byName[0] : undefined);
    if (!selected) throw new Error(byName.length > 1 ? 'That profile name is ambiguous; use its directory name.' : 'The requested Chrome profile was not found.');
  } else {
    if (profiles.length !== 1) {
      const options = profiles.map(({ directory, name }) => `${directory} (${name})`).join(', ');
      throw new Error(profiles.length ? `Choose a Chrome profile with --profile. Available: ${options}` : 'No Chrome profiles were found.');
    }
    [selected] = profiles;
  }

  const profileDir = join(root, selected.directory);
  return { ...selected, cookieDb: await cookieDatabase(profileDir) };
}

import { relative, isAbsolute, join, normalize } from 'node:path';
import { Problem } from './outcomes.js';
export interface Mapping {
  source: string;
  destination: string;
  home: string;
  required: boolean;
  copied?: (destination: string) => boolean;
  warn: (message: string) => void;
}
function homeSuffix(path: string, home: string): string | null {
  const suffix = relative(home, path);
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('../')) {
    return null;
  }
  return suffix;
}
function safeInsertion(value: string): boolean {
  return !/[\s'"`$;&|<>()[\]{}*?!\\\x00-\x1f\x7f]/u.test(value);
}
export function mapReference(value: string, command: boolean, mapping: Mapping): string {
  const sourceSuffix = homeSuffix(mapping.source, mapping.home);
  const destinationSuffix = homeSuffix(mapping.destination, mapping.home);
  const forms = [{ from: mapping.source, to: mapping.destination, home: false }];
  if (sourceSuffix !== null && destinationSuffix !== null) {
    for (const prefix of ['~/', '$HOME/', '${HOME}/']) {
      forms.push({ from: prefix + sourceSuffix, to: prefix + destinationSuffix, home: true });
    }
  }
  forms.sort((a, b) => b.from.length - a.from.length);
  let result = '';
  for (let i = 0; i < value.length;) {
    let consumed = 0;
    const before = value[i - 1];
    const form = forms.find(candidate => {
      let length = candidate.from.length;
      if (!value.startsWith(candidate.from, i)) {
        if (value[i] !== candidate.from[0]) {
          return false;
        }
        const token = value.slice(i).match(/^[^'";|&<>)]*/)?.[0] ?? '';
        length = 0;
        for (let end = 1; end <= token.length; end++) {
          if (end !== token.length && !/[\/\s:;,]/.test(token[end]!)) {
            continue;
          }
          if (normalize(token.slice(0, end)) === normalize(candidate.from)) {
            length = end;
            break;
          }
        }
        if (!length) {
          return false;
        }
      }
      const after = value[i + length];
      if (after && /[A-Za-z0-9._@+-]/.test(after)) {
        return false;
      }
      consumed = length;
      return true;
    });
    if (!form) {
      result += value[i++];
      continue;
    }
    const refuse = () => {
      mapping.warn('A reference has an unsupported or ambiguous path suffix and was kept unchanged.');
      return value;
    };
    if (before && !/[\s'"=:]/.test(before)) {
      return refuse();
    }
    const end = i + consumed;
    const remainder = value.slice(end);
    const quote = before === "'" || before === '"' ? before : null;
    const close = quote ? remainder.indexOf(quote) : -1;
    if (quote && (close < 0 || (remainder[close + 1] && !/\s/.test(remainder[close + 1]!)))) {
      return refuse();
    }
    const tail = quote ? remainder.slice(0, close) : remainder;
    // Treat the complete suffix as data; shell punctuation is never a path delimiter.
    if ((tail && !tail.startsWith('/')) || !/^[A-Za-z0-9._@+,=:/ -]*$/.test(tail)
      || tail.split('/').some(segment => segment === '.' || segment === '..')) {
      return refuse();
    }
    const suffix = relative(normalize(mapping.source), normalize(mapping.source + tail));
    if (suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)
      || suffix.split('/').some(segment => segment === '.' || segment === '..')) {
      return refuse();
    }
    const path = join(mapping.destination, suffix);
    if (mapping.copied && !mapping.copied(path)) {
      result += value.slice(i, end) + tail;
      i = end + tail.length;
      continue;
    }
    const inserted = form.home ? destinationSuffix! : form.to;
    if (command && !safeInsertion(inserted)) {
      if (mapping.required) {
        throw new Problem('mapping-command', 'A required command path migration contains unsafe inserted syntax.');
      }
      mapping.warn('A command reference was kept because its replacement path is unsafe.');
      result += value.slice(i, end) + tail;
    } else {
      result += form.to + (tail.startsWith('/') ? (suffix ? '/' + suffix : '') : tail);
    }
    i = end + tail.length;
  }
  return result;
}
function visit(value: unknown, command: boolean, mapping: Mapping): unknown {
  if (typeof value === 'string') {
    return mapReference(value, command, mapping);
  }
  if (Array.isArray(value)) {
    return value.map(child => visit(child, command, mapping));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child, command, mapping)]));
  }
  return value;
}
export function migrateDocument(name: string, value: unknown, mapping: Mapping): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const document = value as Record<string, unknown>;
  if (['plugins/installed_plugins.json', 'plugins/known_marketplaces.json'].includes(name)) {
    return visit(document, false, mapping);
  }
  const result = { ...document };
  const fields = name === 'settings.json' ? ['hooks', 'statusLine'] : name === '.claude.json' ? ['mcpServers'] : [];
  for (const key of fields) {
    if (Object.hasOwn(document, key)) {
      result[key] = visit(document[key], true, mapping);
    }
  }
  return result;
}

import { join } from 'node:path';
import { execute, systemTools, nativeIdentities } from './machine-services.js';
import type { IdentityService } from './machine-services.js';
import type { NativeTool } from './claude-authenticity.js';
import { desktopNativeCensus, sameDesktopProcess } from './process-census.js';
import type { DesktopCensus, DesktopProcess } from './process-census.js';
import { authenticationOverrides, githubOverrides } from './execution-policy.js';
import { Problem, Exit } from './outcomes.js';
export type Tint = 'none' | 'amber' | 'copper' | 'mint' | 'sky' | 'violet' | 'rose';
export interface DesktopArtifacts {
  tool: NativeTool;
  copy(source: string, target: string, clone: boolean): Promise<void>;
  tint(path: string, selection: Tint): Promise<void>;
  icon?(source: string, target: string): Promise<void>;
  clearTint?(path: string): Promise<void>;
  version(path: string): Promise<string | null>;
  compile(sourceFile: string, target: string): Promise<void>;
}
export interface DesktopServices extends DesktopArtifacts {
  identities: IdentityService;
  census(): Promise<DesktopCensus>;
  confirmWrong(label: string, processes: readonly DesktopProcess[]): Promise<boolean>;
  terminate(process: DesktopProcess): Promise<void>;
  open(args: string[], env: NodeJS.ProcessEnv): Promise<void>;
  notify(message: string): Promise<void>;
  launchdOverrides?(): Promise<string[]>;
  register?(launcher: string): Promise<boolean>;
  unregister?(application: string): Promise<boolean>;
  refreshDock?(launcher: string): Promise<void>;
  checkpoint?(stage: string): Promise<void> | void;
  contentionMs?: number;
}
const tintScript = String.raw`ObjC.import('AppKit');
function run(argv) {
  const palette = {
    amber: [0.97, 0.66, 0.17], copper: [0.72, 0.37, 0.23], mint: [0.23, 0.72, 0.53],
    sky: [0.23, 0.59, 0.89], violet: [0.58, 0.39, 0.85], rose: [0.89, 0.35, 0.54]
  };
  const color = palette[argv[1]];
  if (!color) throw new Error('Unsupported icon selection');
  const workspace = $.NSWorkspace.sharedWorkspace;
  const image = workspace.iconForFile($(argv[0])).copy;
  const size = image.size;
  image.lockFocus;
  $.NSColor.colorWithCalibratedRedGreenBlueAlpha(color[0], color[1], color[2], 0.45).setFill;
  $.NSRectFillUsingOperation($.NSMakeRect(0, 0, size.width, size.height), $.NSCompositingOperationSourceAtop);
  image.unlockFocus;
  if (!workspace.setIconForFileOptions(image, $(argv[0]), 0)) throw new Error('Icon metadata was refused');
}`;
export function productionDesktopArtifacts(): DesktopArtifacts {
  const tool: NativeTool = (file, args) => execute(file, args, { timeout: 120000 });
  return {
    tool,
    async copy(source, target, clone) {
      const result = await tool(clone ? '/bin/cp' : '/usr/bin/ditto',
        clone ? ['-cR', source, target] : [source, target]);
      if (result.code !== 0) {
        throw new Problem('copy-command', 'The application copy command failed.', Exit.failure);
      }
    },
    async tint(path, selection) {
      if (selection === 'none') {
        return;
      }
      const result = await tool(systemTools.osascript, ['-l', 'JavaScript', '-e', tintScript, '--', path, selection]);
      if (result.code !== 0) {
        throw new Problem('icon-metadata', 'Finder custom-icon metadata could not be applied.', Exit.unavailable);
      }
    },
    async clearTint(path) {
      const script = "ObjC.import('AppKit'); function run(a) { "
      + 'if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(null, $(a[0]), 0)) '
      + 'throw new Error("Icon cleanup refused"); }';
      const result = await tool(systemTools.osascript, ['-l', 'JavaScript', '-e', script, '--', path]);
      if (result.code !== 0) {
        throw new Problem('icon-metadata', 'Finder custom-icon metadata could not be cleared.', Exit.unavailable);
      }
    },
    async icon(source, target) {
      const script = String.raw`ObjC.import('AppKit');
function run(a) {
  const workspace = $.NSWorkspace.sharedWorkspace;
  if (!workspace.setIconForFileOptions(workspace.iconForFile($(a[0])), $(a[1]), 0)) {
    throw new Error('Icon refused');
  }
}`;
      const result = await tool(systemTools.osascript, ['-l', 'JavaScript', '-e', script, '--', source, target]);
      if (result.code !== 0) {
        throw new Problem('launcher-icon', 'The launcher icon could not be set.', Exit.unavailable);
      }
    },
    async version(path) {
      const result = await tool('/usr/bin/plutil', [
        '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(path, 'Contents/Info.plist'),
      ]);
      const value = result.stdout.trim();
      return result.code === 0 && /^\d+(?:\.\d+)*$/.test(value) ? value : null;
    },
    async compile(sourceFile, target) {
      const result = await tool(systemTools.osacompile, ['-o', target, sourceFile]);
      if (result.code !== 0) {
        throw new Problem('launcher-compile', 'The Dock launcher could not be compiled.', Exit.unavailable);
      }
    },
  };
}
const launchServices = '/System/Library/Frameworks/CoreServices.framework/Frameworks/'
+ 'LaunchServices.framework/Support/lsregister';
export function productionDesktopServices(): DesktopServices {
  const artifacts = productionDesktopArtifacts();
  return {
    ...artifacts,
    identities: nativeIdentities(),
    census: () => desktopNativeCensus(),
    async confirmWrong(label) {
      const script = 'on run argv\n'
      + 'display dialog ("Close the wrong-location Claude instance for profile " & item 1 of argv & "?") '
      + 'buttons {"Leave Running", "Close Instance"} default button "Leave Running" cancel button "Leave Running"\n'
      + 'return button returned of result\nend run';
      const result = await execute(systemTools.osascript, ['-e', script, '--', label], { timeout: 120000 });
      return result.code === 0 && result.stdout.trim() === 'Close Instance';
    },
    async terminate(process) {
      const census = await desktopNativeCensus();
      if (!census.available || !census.processes.some(value => sameDesktopProcess(process, value))) {
        throw new Problem('desktop-quit-race', 'Process identity changed before native termination.');
      }
      const epoch = Math.floor(Date.parse(process.start) / 1000);
      if (!Number.isFinite(epoch)) {
        throw new Problem('desktop-start', 'The confirmed process start time is unreadable.');
      }
      // Bind the final request to an application object with the same launch date and bundle paths.
      const script = String.raw`ObjC.import('AppKit');
function run(a) {
  const application = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(a[0]));
  if (!application || !application.launchDate
    || Math.floor(Number(application.launchDate.timeIntervalSince1970)) !== Number(a[4])
    || ObjC.unwrap(application.executableURL.path) !== a[1]
    || ObjC.unwrap(application.bundleURL.path) !== a[2]
    || ObjC.unwrap(application.bundleIdentifier) !== a[3]) {
    throw new Error('Process changed');
  }
  if (!application.terminate) {
    throw new Error('Termination refused');
  }
}`;
      const result = await artifacts.tool(systemTools.osascript, [
        '-l', 'JavaScript', '-e', script, '--', String(process.pid), process.executable,
        process.bundle, process.bundleId, String(epoch),
      ]);
      if (result.code !== 0) {
        throw new Problem('desktop-quit', 'Graceful application termination was refused.');
      }
    },
    async register(launcher) {
      const result = await artifacts.tool(launchServices, ['-f', launcher]);
      return result.code === 0;
    },
    async unregister(application) {
      const result = await artifacts.tool(launchServices, ['-u', application]);
      return result.code === 0;
    },
    async refreshDock(launcher) {
      const touch = await artifacts.tool('/usr/bin/touch', [launcher]);
      if (touch.code !== 0) {
        throw new Problem('dock-touch', 'The owned launcher could not be touched.');
      }
      const result = await artifacts.tool('/usr/bin/killall', ['Dock']);
      if (result.code !== 0) {
        throw new Problem('dock-restart', 'The requested Dock restart was unavailable.', Exit.unavailable);
      }
    },
    async launchdOverrides() {
      const names: string[] = [];
      for (const name of [...authenticationOverrides, ...githubOverrides, 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR']) {
        const result = await execute('/bin/launchctl', ['getenv', name]);
        if (result.code === 0) {
          names.push(name);
        }
      }
      return names;
    },
    async open(args, env) {
      const result = await execute(systemTools.open, args, { env, timeout: 20000 });
      if (result.code !== 0) {
        throw new Problem('desktop-open', 'LaunchServices did not accept the profile request.', Exit.failure);
      }
    },
    async notify(message) {
      await execute(systemTools.osascript, [
        '-e', 'on run argv\ndisplay dialog (item 1 of argv) buttons {"Close"} default button "Close"\nend run',
        '--', message,
      ], { timeout: 120000 });
    },
  };
}

/** macOS Seatbelt confinement, retained for the desktop and web launchers. */
import { isAbsolute } from 'node:path';
import { PentestError } from '@dsh-pentest/contracts';
const quote = (value: string): string => JSON.stringify(value);
export interface SandboxOptions { writableRoots: string[]; readableRoots?: string[]; proxyPort?: number; unixSocketRoots?: string[] }
export function sandboxProfile(options: SandboxOptions): string {
  if (options.writableRoots.some(path => !isAbsolute(path) || path === '/')) throw new PentestError('SANDBOX_ROOT', 'Worker write roots must be absolute, bounded directories');
  if (options.proxyPort !== undefined && (!Number.isInteger(options.proxyPort) || options.proxyPort < 1 || options.proxyPort > 65535)) throw new PentestError('SANDBOX_PORT', 'Invalid broker port');
  return ['(version 1)', '(allow default)', '(deny network-outbound)', '(deny network-inbound)', '(deny network-bind)', '(deny file-write*)',
    // dyld opens the root directory on current macOS. A literal grant permits that
    // operation without permitting the contents of users' home directories.
    ...(options.readableRoots ? ['(deny file-read*)', '(allow file-read-metadata)', '(allow file-read* (literal "/") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library") (subpath "/dev"))',
      ...[...options.readableRoots, ...options.writableRoots].map(path => `(allow file-read* (subpath ${quote(path)}))`)] : []),
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))',
    ...options.writableRoots.map(path => `(allow file-write* (subpath ${quote(path)}))`),
    ...(options.unixSocketRoots ?? []).flatMap(path => [
      // Explicit operation names are required: the network* wildcard loses to
      // the specific deny rules above, even for a matching private socket path.
      `(allow network-bind network-inbound (local unix-socket (subpath ${quote(path)})))`,
      `(allow network-outbound (remote unix-socket (subpath ${quote(path)})))`,
    ]),
    // Only this private proxy can open Internet sockets on a worker's behalf.
    ...(options.proxyPort ? [`(allow network-outbound (remote ip "localhost:${options.proxyPort}"))`] : []),
  ].join('\n');
}

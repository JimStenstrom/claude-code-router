import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'fs';
import { PID_FILE, REFERENCE_COUNT_FILE, MAX_PID_VALUE } from '../constants';
import { readConfigFile } from '.';
import find from 'find-process';
import { execSync } from 'child_process';

const LOCK_FILE = `${REFERENCE_COUNT_FILE}.lock`;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_INTERVAL_MS = 50;
const MAX_LOCK_RETRIES = 100; // 100 retries * 50ms = 5 seconds max

/**
 * Synchronous sleep using spawnSync
 * More CPU-friendly than busy-wait loop
 */
function syncSleep(ms: number): void {
    try {
        // Use node's built-in setTimeout via child process for cross-platform sleep
        require('child_process').spawnSync('node', ['-e', `setTimeout(() => {}, ${ms})`], {
            timeout: ms + 100
        });
    } catch {
        // Fallback: short busy wait if spawn fails (shouldn't happen)
        const end = Date.now() + ms;
        while (Date.now() < end) { /* fallback busy wait */ }
    }
}

/**
 * Acquire a file lock with timeout
 * Returns true if lock acquired, false otherwise
 */
function acquireLock(): boolean {
    for (let retry = 0; retry < MAX_LOCK_RETRIES; retry++) {
        try {
            // O_CREAT | O_EXCL - fails if file exists (atomic check-and-create)
            const fd = openSync(LOCK_FILE, 'wx');
            closeSync(fd);
            return true;
        } catch (e: unknown) {
            const err = e as NodeJS.ErrnoException;
            if (err.code === 'EEXIST') {
                // Lock file exists, check if it's stale (older than timeout)
                try {
                    const stats = require('fs').statSync(LOCK_FILE);
                    if (Date.now() - stats.mtimeMs > LOCK_TIMEOUT_MS) {
                        // Stale lock, remove it
                        try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
                    }
                } catch { /* ignore stat errors */ }

                // Wait before retrying using non-busy sleep
                syncSleep(LOCK_RETRY_INTERVAL_MS);
            } else {
                // Other error, fail immediately
                return false;
            }
        }
    }
    return false;
}

/**
 * Release the file lock
 */
function releaseLock(): void {
    try {
        unlinkSync(LOCK_FILE);
    } catch { /* ignore */ }
}

export async function isProcessRunning(pid: number): Promise<boolean> {
    try {
        const processes = await find('pid', pid);
        return processes.length > 0;
    } catch (error) {
        return false;
    }
}

/**
 * Atomically increment the reference count with file locking
 */
export function incrementReferenceCount(): void {
    if (!acquireLock()) {
        console.warn('Failed to acquire lock for reference count increment');
        return;
    }
    try {
        let count = 0;
        if (existsSync(REFERENCE_COUNT_FILE)) {
            count = parseInt(readFileSync(REFERENCE_COUNT_FILE, 'utf-8')) || 0;
        }
        count++;
        writeFileSync(REFERENCE_COUNT_FILE, count.toString());
    } finally {
        releaseLock();
    }
}

/**
 * Atomically decrement the reference count with file locking
 */
export function decrementReferenceCount(): void {
    if (!acquireLock()) {
        console.warn('Failed to acquire lock for reference count decrement');
        return;
    }
    try {
        let count = 0;
        if (existsSync(REFERENCE_COUNT_FILE)) {
            count = parseInt(readFileSync(REFERENCE_COUNT_FILE, 'utf-8')) || 0;
        }
        count = Math.max(0, count - 1);
        writeFileSync(REFERENCE_COUNT_FILE, count.toString());
    } finally {
        releaseLock();
    }
}

/**
 * Get the current reference count with file locking for consistency
 */
export function getReferenceCount(): number {
    if (!existsSync(REFERENCE_COUNT_FILE)) {
        return 0;
    }
    if (!acquireLock()) {
        // If we can't get the lock, still try to read (best effort)
        try {
            return parseInt(readFileSync(REFERENCE_COUNT_FILE, 'utf-8')) || 0;
        } catch {
            return 0;
        }
    }
    try {
        return parseInt(readFileSync(REFERENCE_COUNT_FILE, 'utf-8')) || 0;
    } finally {
        releaseLock();
    }
}

export function isServiceRunning(): boolean {
    if (!existsSync(PID_FILE)) {
        return false;
    }

    let pid: number;
    try {
        const pidStr = readFileSync(PID_FILE, 'utf-8').trim();
        pid = parseInt(pidStr, 10);
        // Validate PID is a positive integer within valid range (prevents command injection)
        if (isNaN(pid) || pid <= 0 || pid > MAX_PID_VALUE || !/^\d+$/.test(pidStr)) {
            // PID file content is invalid or potentially malicious
            cleanupPidFile();
            return false;
        }
    } catch (e) {
        // Failed to read file
        return false;
    }

    try {
        if (process.platform === 'win32') {
            // --- Windows platform logic ---
            // Use tasklist command with PID filter to find the process
            // stdio: 'pipe' suppresses command output to prevent console display
            // PID is validated above to be a safe integer value
            const command = `tasklist /FI "PID eq ${pid}"`;
            const output = execSync(command, { stdio: 'pipe' }).toString();

            // If output contains the PID, the process exists
            // When tasklist doesn't find a process it returns "INFO: No tasks are running..."
            // So a simple contains check is sufficient
            if (output.includes(pid.toString())) {
                return true;
            } else {
                // Theoretically this won't be reached if tasklist executes successfully but finds nothing
                // But as a safeguard, we still consider the process as non-existent
                cleanupPidFile();
                return false;
            }

        } else {
            // --- Linux, macOS and other platforms logic ---
            // Use signal 0 to check if process exists without actually killing it
            process.kill(pid, 0);
            return true; // If no exception is thrown, the process exists
        }
    } catch (e) {
        // Exception caught means process doesn't exist (whether from kill or execSync failure)
        // Clean up the invalid PID file
        cleanupPidFile();
        return false;
    }
}

export function savePid(pid: number) {
    writeFileSync(PID_FILE, pid.toString());
}

export function cleanupPidFile() {
    if (existsSync(PID_FILE)) {
        try {
            const fs = require('fs');
            fs.unlinkSync(PID_FILE);
        } catch (e) {
            // Ignore cleanup errors
        }
    }
}

export function getServicePid(): number | null {
    if (!existsSync(PID_FILE)) {
        return null;
    }

    try {
        const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));
        return isNaN(pid) ? null : pid;
    } catch (e) {
        return null;
    }
}

export async function getServiceInfo() {
    const pid = getServicePid();
    const running = await isServiceRunning();
    const config = await readConfigFile();
    const port = config.PORT || 3456;

    return {
        running,
        pid,
        port,
        endpoint: `http://127.0.0.1:${port}`,
        pidFile: PID_FILE,
        referenceCount: getReferenceCount()
    };
}

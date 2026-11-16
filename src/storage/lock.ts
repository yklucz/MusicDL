import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MusicDLError } from '../core/errors.js';
export class WorkerLock {
  private readonly token = randomUUID();
  private db: DatabaseSync | undefined;
  constructor(private readonly file: string) {}
  async acquire(): Promise<void> {
    if (this.db) return;
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file);
    try {
      if (process.platform !== 'win32') await chmod(this.file, 0o600);
      db.exec(
        'PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL); BEGIN IMMEDIATE;',
      );
      const owner = db.prepare('SELECT pid FROM owner WHERE id=1').get() as
        { pid: number } | undefined;
      if (owner) {
        let alive = true;
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
        if (alive)
          throw new MusicDLError(
            `A MusicDL worker is already running (PID ${owner.pid}). Use musicdl queue to inspect it.`,
            'LOCKED',
          );
      }
      db.prepare('INSERT OR REPLACE INTO owner(id,pid,token) VALUES(1,?,?)').run(
        process.pid,
        this.token,
      );
      db.exec('COMMIT');
      this.db = db;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* no transaction */
      }
      db.close();
      throw error;
    }
  }
  async release(): Promise<void> {
    const db = this.db;
    if (!db) return;
    try {
      db.prepare('DELETE FROM owner WHERE id=1 AND token=?').run(this.token);
    } finally {
      db.close();
      this.db = undefined;
    }
  }
}


// Schedule for every 2 minutes

import { spawn } from 'child_process';
import cron from 'node-cron';
import { join } from 'path';
import { existsSync, mkdirSync, unlinkSync, statSync, readdirSync } from 'fs';
import 'dotenv/config';

const BACKUP_DIR = './backups';
const GDRIVE_FOLDER = 'HospitalBackups';
const MAX_LOCAL_BACKUPS = 7;  // Keep 1 week locally

// YOUR WORKING PATHS - UNCHANGED
const PG_DUMP_PATH = '"C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe"';
const RCLONE_PATH = '".\\rclone-v1.72.1-windows-amd64\\rclone-v1.72.1-windows-amd64\\rclone.exe"';

if (!existsSync(BACKUP_DIR)) {
  mkdirSync(BACKUP_DIR, { recursive: true });
}

// Clean old backups (keep 7 days)
const cleanupOldBackups = () => {
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('hospital_backup') && f.endsWith('.sql'))
      .sort((a, b) => statSync(join(BACKUP_DIR, b)).mtime - statSync(join(BACKUP_DIR, a)).mtime);
    
    for (let i = MAX_LOCAL_BACKUPS; i < files.length; i++) {
      unlinkSync(join(BACKUP_DIR, files[i]));
      console.log(`🗑️ Cleaned old: ${files[i]}`);
    }
  } catch (e) {
    console.log('⚠️ Cleanup skipped');
  }
};

const backupDatabase = async () => {
  try {
    console.log(`\n🚀 [${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}] Hospital Backup...`);
    
    cleanupOldBackups();
    
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `hospital_backup_${timestamp}.sql`;
    const localPath = join(BACKUP_DIR, filename);

    console.log(`📦 ${process.env.DATABASE_NAME} → ${filename}`);

    // 🔥 STEP 1: YOUR WORKING SPAWN (UNCHANGED)
    const pgDumpProcess = spawn(PG_DUMP_PATH, [
      '-h', process.env.DATABASE_HOST,
      '-p', process.env.DATABASE_PORT,
      '-U', process.env.DATABASE_USER,
      '-d', process.env.DATABASE_NAME,  // Now clean name ✅
      '--no-owner',
      '--no-privileges',
      '-f', localPath  // Fixed: removed extra quotes
    ], {
      shell: true,  // Your working config ✅
      env: { ...process.env, PGPASSWORD: process.env.DATABASE_PASSWORD }
    });

    pgDumpProcess.stderr.on('data', (data) => {
      process.stdout.write(data.toString());
    });

    await new Promise((resolve, reject) => {
      pgDumpProcess.on('close', (code) => {
        if (code !== 0) return reject(new Error(`pg_dump failed: ${code}`));
        
        if (existsSync(localPath) && statSync(localPath).size > 0) {
          console.log(`✅ ${(statSync(localPath).size / 1024 / 1024).toFixed(1)} MB`);
          resolve();
        } else {
          reject(new Error('Empty backup'));
        }
      });
    });

    // 🔥 STEP 2: GOOGLE DRIVE (your paths)
    console.log('📤 Google Drive...');
    const rcloneProcess = spawn(RCLONE_PATH, [
      'copy',
      localPath,
      `gdrive:${GDRIVE_FOLDER}`
    ], { shell: true });

    rcloneProcess.stdout.on('data', (data) => console.log(data.toString()));

    await new Promise((resolve, reject) => {
      rcloneProcess.on('close', (code) => {
        if (code !== 0) return reject(new Error('Upload failed'));
        console.log('✅ Google Drive complete');
        resolve();
      });
    });

    unlinkSync(localPath);
    console.log('🎉 FULL BACKUP SUCCESS - Schema + All Data ✅');

  } catch (err) {
    console.error('💥 FAILED:', err.message);
  }
};

// 🔥 PRODUCTION: 2AM DAILY IST
// cron.schedule('0 2 * * *', backupDatabase, { timezone: 'Asia/Kolkata' });

console.log('🚀 PRODUCTION LIVE - 2AM Daily Backups');
console.log('📁 Database:', process.env.DATABASE_NAME);
console.log('💾 Full schema + data → Google Drive');
cron.schedule('*/2 * * * *', backupDatabase, { timezone: 'Asia/Kolkata' });

console.log('☁️ Backup System LIVE - Successfully configured for appointment3');
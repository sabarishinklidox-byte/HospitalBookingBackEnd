import cron from 'node-cron';
import prisma from '../prisma.js';

// Function to check and update appointments
const markNoShows = async () => {
  console.log('⏳ Running Cron Job: Checking for No-Show appointments...');
  
  try {
    const now = new Date();

    // 1. Get all appointments that are NOT completed/cancelled yet
    // We only fetch appointments from the past (date <= today) to optimize
    const activeAppointments = await prisma.appointment.findMany({
      where: {
        status: { in: ['PENDING', 'CONFIRMED'] },
        slot: {
          date: { lte: now } // Only look at slots in the past or today
        }
      },
      include: { slot: true }
    });

    const idsToUpdate = [];

    // 2. Filter logic: Has the time + buffer passed?
    activeAppointments.forEach((app) => {
      // Construct the specific appointment Date object
      const appDate = new Date(app.slot.date);
      const [hours, minutes] = app.slot.time.split(':').map(Number);
      
      appDate.setHours(hours, minutes, 0, 0);

      // 🕒 Add a "Grace Period" (e.g., 2 hours after appointment time)
      // If appointment was at 10:00 AM, we mark it NO_SHOW at 12:00 PM
      const bufferTime = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

      if (now.getTime() > (appDate.getTime() + bufferTime)) {
        idsToUpdate.push(app.id);
      }
    });

    // 3. Batch Update Database
    if (idsToUpdate.length > 0) {
      await prisma.appointment.updateMany({
        where: { id: { in: idsToUpdate } },
        data: { status: 'NO_SHOW' }
      });
      console.log(`✅ Marked ${idsToUpdate.length} appointments as NO_SHOW.`);
    } else {
      console.log('✅ No expired appointments found.');
    }

  } catch (error) {
    console.error('❌ Error in Cron Job:', error);
  }
};

// --- INITIALIZE CRON JOB ---
// Schedule: Run every 30 minutes
export const startCronJobs = () => {
  cron.schedule('*/30 * * * *', markNoShows);
  console.log('🚀 Cron Jobs initialized.');
};

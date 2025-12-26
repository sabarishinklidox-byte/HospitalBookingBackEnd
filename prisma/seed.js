import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const initialSpecialities = [
  "Dentist",
  "Cardiologist",
  "Neurologist",
  "Orthopedic",
  "Gynecologist",
  "Pediatrician",
  "Dermatologist",
  "Ophthalmologist",
  "General Physician",
  "Other"
];

async function main() {
  console.log('Seeding specialities...');
  
  for (const name of initialSpecialities) {
    await prisma.speciality.upsert({
      where: { name: name },
      update: {},
      create: { name: name },
    });
  }
  
  console.log('Seeding completed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

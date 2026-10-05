import { PageHeader, Card, AEmpty } from "@/components/admin/ui";

/** Lab work queue. The queue itself (orders, samples, results) arrives with the sample-collection phase. */
export default function LabHomePage() {
  return (
    <div>
      <PageHeader title="Ish navbati" subtitle="Laboratoriya buyurtmalari, namunalar va natijalar" />
      <Card>
        <AEmpty title="Hozircha navbatda ish yo‘q" subtitle="Buyurtmalar va namunalar shu yerda ko‘rinadi" />
      </Card>
    </div>
  );
}

import { ConfirmationRaceDemo } from '@/components/ConfirmationRaceDemo';
import { Page } from '@/components/PageLayout';

export default function Home() {
  return (
    <>
      <Page.Main className="flex flex-col items-center justify-start gap-4 pb-6">
        <ConfirmationRaceDemo />
      </Page.Main>
    </>
  );
}

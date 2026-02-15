import { ConfirmationRaceDemo } from '@/components/ConfirmationRaceDemo';
import { Page } from '@/components/PageLayout';
import { TopBar } from '@worldcoin/mini-apps-ui-kit-react';

export default function Home() {
  return (
    <>
      <Page.Header className="p-0">
        <TopBar title="Confirmation Demo" />
      </Page.Header>
      <Page.Main className="flex flex-col items-center justify-start gap-4 pb-6">
        <ConfirmationRaceDemo />
      </Page.Main>
    </>
  );
}

import { Page } from '@/components/PageLayout';

export default function TabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Page>
      {children}
    </Page>
  );
}

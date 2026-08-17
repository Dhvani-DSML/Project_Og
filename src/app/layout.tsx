import "./globals.css";

export const metadata = {
  title: "GraphRAG",
  description: "Multi-hop code intelligence agent",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

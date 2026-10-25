import Link from "next/link";
import Mark from "../mark";
import DemoShops from "./demo-shops";

export default function ShopsPage() {
  return (
    <main className="stage full">
      <section className="sheet gallery">
        <header className="gallery-head">
          <div>
            <Mark />
            <h1 className="title">NYC demo shops</h1>
            <p className="region">Discover, approve and pay over x402. On this page you play both the agent and the traveler.</p>
          </div>
          <div className="gallery-actions">
            <Link className="change" href="/">Trip</Link>
          </div>
        </header>
        <DemoShops />
      </section>
    </main>
  );
}

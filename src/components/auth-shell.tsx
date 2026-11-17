import {
  ArrowRightLeft,
  Building2,
  Calendar,
  Car,
  Laptop,
  Monitor,
  Package,
  ShieldCheck,
  Wrench,
} from "lucide-react";

type IconType = React.ComponentType<{ className?: string }>;

function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5">
        <Package className="h-4 w-4 text-white" />
      </div>
      <span className="text-sm font-semibold uppercase tracking-[0.2em] text-white">
        AssetFlow
      </span>
    </div>
  );
}

function Tab({ icon: Icon, children, active }: { icon: IconType; children: string; active?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 border-b-2 px-3 pb-2.5 text-xs font-medium ${
        active ? "border-blue-500 text-white" : "border-transparent text-neutral-500"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </div>
  );
}

function Chip({ icon: Icon, children, active }: { icon: IconType; children: string; active?: boolean }) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs ${
        active
          ? "border border-white/10 bg-white/10 font-medium text-white"
          : "text-neutral-500"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </div>
  );
}

function FloatingKey({
  icon: Icon,
  className,
  lineSide,
}: {
  icon: IconType;
  className: string;
  lineSide: "left" | "right";
}) {
  return (
    <div aria-hidden className={`absolute flex items-center gap-2 ${className}`}>
      {lineSide === "left" && <span className="h-px w-8 bg-blue-500" />}
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-neutral-800 shadow-lg shadow-black/40">
        <Icon className="h-4 w-4 text-neutral-200" />
      </div>
      {lineSide === "right" && <span className="h-px w-8 bg-blue-500" />}
    </div>
  );
}

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-black sm:p-4 lg:p-6">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl overflow-hidden bg-neutral-950 sm:min-h-[calc(100vh-2rem)] sm:rounded-[2rem] sm:border sm:border-white/10 lg:min-h-[calc(100vh-3rem)] lg:grid-cols-2 lg:p-3">
        {/* ───────── Brand panel (desktop only) ───────── */}
        <aside className="relative hidden flex-col justify-between overflow-hidden rounded-2xl border border-white/5 bg-neutral-900/70 p-8 lg:flex">
          {/* dotted texture that fades out toward the edges (no glow) */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.22)_1px,transparent_1.2px)] bg-size-[14px_14px] mask-[radial-gradient(ellipse_80%_60%_at_65%_45%,black,transparent)]"
          />

          <Logo className="relative" />

          {/* product preview, clipped by the panel edge */}
          <div
            aria-hidden
            className="absolute left-10 top-[42%] w-lg -translate-y-1/2 rounded-2xl border border-white/10 bg-neutral-950 shadow-2xl shadow-black/60"
          >
            <div className="flex items-center gap-1 border-b border-white/5 px-3 pt-3">
              <Tab icon={ArrowRightLeft} active>Allocate</Tab>
              <Tab icon={Calendar}>Book</Tab>
              <Tab icon={Wrench}>Maintain</Tab>
            </div>

            <div className="p-4">
              <div className="rounded-xl border border-white/5 bg-white/3 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-white">MacBook Pro 14&quot;</p>
                    <p className="mt-0.5 text-xs text-neutral-500">AF-0114 · Laptops</p>
                  </div>
                  <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
                    Available
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-white/5 bg-neutral-900 p-3">
                    <p className="text-[11px] text-neutral-500">Assign to</p>
                    <p className="mt-1 text-sm text-neutral-200">Priya Shah</p>
                  </div>
                  <div className="rounded-lg border border-white/5 bg-neutral-900 p-3">
                    <p className="text-[11px] text-neutral-500">Return by</p>
                    <p className="mt-1 text-sm text-neutral-200">30 Oct 2026</p>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex gap-1 rounded-xl border border-white/5 bg-white/2 p-1">
                <Chip icon={Laptop} active>Laptops</Chip>
                <Chip icon={Building2}>Rooms</Chip>
                <Chip icon={Car}>Vehicles</Chip>
                <Chip icon={Monitor}>Displays</Chip>
              </div>
            </div>
          </div>

          <div className="relative max-w-sm mt-12">
            <h2 className="font-serif text-5xl leading-[1.05] tracking-tight text-white">
              Every asset, accounted for.
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-neutral-400">
              Track, allocate and maintain your organization&apos;s equipment and shared resources.
            </p>
          </div>
        </aside>

        {/* ───────── Form panel ───────── */}
        <section className="flex items-center justify-center px-6 py-12 sm:px-10">
          <div className="w-full max-w-88">
            <Logo className="mb-10 lg:hidden" />

            <div className="mb-8">
              <h1 className="font-serif text-4xl tracking-tight text-white">
                {title}
              </h1>
              <p className="mt-2 text-sm text-neutral-400">{subtitle}</p>
            </div>

            {children}
          </div>
        </section>
      </div>
    </main>
  );
}

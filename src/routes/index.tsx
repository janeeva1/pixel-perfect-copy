import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  ShieldCheck,
  Users,
  GraduationCap,
  BarChart3,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/useAuth";
import { useEffect, useRef } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Attendance Register - Student & Staff Attendance Management" },
      {
        name: "description",
        content:
          "Create attendance sessions, upload biometric machine exports, and get instant present and absent registers for students and staff.",
      },
      {
        property: "og:title",
        content: "Attendance Register - Student & Staff Attendance Management",
      },
      {
        property: "og:description",
        content:
          "Create attendance sessions, upload biometric machine exports, and get instant present and absent registers.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

function BackgroundCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const context: CanvasRenderingContext2D = ctx as CanvasRenderingContext2D;

    // Spotted motion particles - organic, floating spots
    const spots: Array<{
      x: number;
      y: number;
      baseX: number;
      baseY: number;
      radius: number;
      color: string;
      opacity: number;
      phase: number;
      speed: number;
      amplitude: number;
      frequency: number;
    }> = [];

    // Color palette matching the brand - blue, emerald, violet, orange
    const spotColors = [
      "rgba(59, 130, 246, 0.35)", // blue
      "rgba(16, 185, 129, 0.35)", // emerald
      "rgba(139, 92, 246, 0.35)", // violet
      "rgba(249, 115, 22, 0.35)", // orange
      "rgba(236, 72, 153, 0.3)", // pink
    ];

    function resize() {
      canvas!.width = window.innerWidth;
      canvas!.height = window.innerHeight;
    }

    function initSpots() {
      spots.length = 0;
      const count = Math.min(40, Math.floor((canvas!.width * canvas!.height) / 35000));
      for (let i = 0; i < count; i++) {
        const baseX = Math.random() * canvas!.width;
        const baseY = Math.random() * canvas!.height;
        spots.push({
          x: baseX,
          y: baseY,
          baseX,
          baseY,
          radius: Math.random() * 4 + 2,
          color: spotColors[Math.floor(Math.random() * spotColors.length)]!,
          opacity: Math.random() * 0.4 + 0.1,
          phase: Math.random() * Math.PI * 2,
          speed: Math.random() * 0.002 + 0.0008,
          amplitude: Math.random() * 60 + 30,
          frequency: Math.random() * 0.0008 + 0.0004,
        });
      }
    }

    function drawSpot(s: (typeof spots)[0]) {
      context.save();
      context.globalAlpha = s.opacity;
      context.fillStyle = s.color;
      context.beginPath();
      context.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }

    // Mouse interaction
    let mouseX = -1000;
    let mouseY = -1000;
    let isHovering = false;

    const handleMouseMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      isHovering = true;
    };

    const handleMouseLeave = () => {
      isHovering = false;
      mouseX = -1000;
      mouseY = -1000;
    };

    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);

    function animate() {
      context.clearRect(0, 0, canvas!.width, canvas!.height);

      // Subtle gradient mesh background
      const gradient = context.createRadialGradient(
        canvas!.width * 0.3,
        canvas!.height * 0.2,
        0,
        canvas!.width * 0.3,
        canvas!.height * 0.2,
        Math.max(canvas!.width, canvas!.height) * 0.8,
      );
      gradient.addColorStop(0, "rgba(59, 130, 246, 0.02)");
      gradient.addColorStop(0.5, "rgba(139, 92, 246, 0.015)");
      gradient.addColorStop(1, "transparent");
      context.fillStyle = gradient;
      context.fillRect(0, 0, canvas!.width, canvas!.height);

      // Second gradient
      const gradient2 = context.createRadialGradient(
        canvas!.width * 0.7,
        canvas!.height * 0.8,
        0,
        canvas!.width * 0.7,
        canvas!.height * 0.8,
        Math.max(canvas!.width, canvas!.height) * 0.7,
      );
      gradient2.addColorStop(0, "rgba(16, 185, 129, 0.02)");
      gradient2.addColorStop(1, "transparent");
      context.fillStyle = gradient2;
      context.fillRect(0, 0, canvas!.width, canvas!.height);

      // Update and draw spots
      const time = Date.now() * 0.001;

      spots.forEach((spot) => {
        // Organic floating motion with phase offset
        spot.x = spot.baseX + Math.sin(time * spot.speed + spot.phase) * spot.amplitude;
        spot.y =
          spot.baseY + Math.cos(time * spot.speed * 0.7 + spot.phase * 1.3) * spot.amplitude * 0.8;

        // Mouse attraction/repulsion
        if (isHovering) {
          const dx = mouseX - spot.x;
          const dy = mouseY - spot.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 180 && dist > 0) {
            const force = ((180 - dist) / 180) * 0.03;
            spot.x -= dx * force;
            spot.y -= dy * force;
          }
        }

        // Subtle breathing radius
        const breathRadius = spot.radius + Math.sin(time * 2 + spot.phase) * 0.5;

        drawSpot({ ...spot, radius: breathRadius });
      });

      // Connections between nearby spots - organic web
      context.strokeStyle = "rgba(59, 130, 246, 0.012)";
      context.lineWidth = 0.4;
      for (let i = 0; i < spots.length; i++) {
        const si = spots[i]!;
        for (let j = i + 1; j < spots.length; j++) {
          const sj = spots[j]!;
          const dx = si.x - sj.x;
          const dy = si.y - sj.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 140) {
            const alpha = (1 - dist / 140) * 0.02;
            context.strokeStyle = `rgba(59, 130, 246, ${alpha})`;
            context.beginPath();
            context.moveTo(si.x, si.y);
            context.lineTo(sj.x, sj.y);
            context.stroke();
          }
        }
      }

      animationRef.current = requestAnimationFrame(animate);
    }

    resize();
    initSpots();
    animate();

    window.addEventListener("resize", () => {
      resize();
      initSpots();
    });

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full pointer-events-none"
      aria-hidden="true"
    />
  );
}

function FloatingOrbs() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
      <div className="absolute top-1/4 left-1/10 w-64 h-64 bg-gradient-to-br from-blue-500/3 to-transparent rounded-full blur-3xl animate-pulse-slow" />
      <div
        className="absolute bottom-1/4 right-1/10 w-80 h-80 bg-gradient-to-bl from-emerald-500/3 to-transparent rounded-full blur-3xl animate-pulse-slow"
        style={{ animationDelay: "2s" }}
      />
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 bg-gradient-to-r from-violet-500/2 to-transparent rounded-full blur-3xl animate-pulse-slow"
        style={{ animationDelay: "4s" }}
      />
      <div className="absolute top-1/5 right-1/5 w-32 h-32 bg-gradient-to-br from-amber-500/3 to-transparent rounded-full blur-2xl animate-bounce-slow" />
      <div
        className="absolute bottom-1/3 left-1/5 w-24 h-24 bg-gradient-to-bl from-rose-500/2 to-transparent rounded-full blur-2xl animate-bounce-slow"
        style={{ animationDelay: "1.5s" }}
      />
    </div>
  );
}

function Landing() {
  const { session, ready } = useSession();

  return (
    <main className="relative min-h-screen overflow-hidden bg-transparent">
      <BackgroundCanvas />
      <FloatingOrbs />

      <header className="relative z-10 border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-gradient-to-br from-blue-500 to-violet-600 rounded-xl">
              <Sparkles className="size-5 text-white" />
            </div>
            <span className="font-display text-lg font-semibold">Attendance Register</span>
          </div>
          {ready && session ? (
            <Button asChild size="sm">
              <Link to="/dashboard">Open dashboard</Link>
            </Button>
          ) : (
            <Button asChild size="sm">
              <Link to="/auth">Sign in</Link>
            </Button>
          )}
        </div>
      </header>

      <section className="relative z-10 mx-auto max-w-5xl px-6 py-20">
        <p className="text-sm font-semibold tracking-widest text-primary uppercase">
          Institutional attendance
        </p>
        <h1 className="mt-4 max-w-2xl text-4xl leading-tight font-semibold sm:text-5xl">
          From biometric export to a verified present-and-absent register.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-muted-foreground">
          Keep one master list of students and staff, define exactly who is expected at a session,
          upload the machine file, and let the register work itself out.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to={session ? "/dashboard" : "/auth"}>
              {session ? "Go to dashboard" : "Get started"} <ArrowRight className="ml-2 size-4" />
            </Link>
          </Button>
        </div>

        <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: Users,
              title: "Master list",
              body: "Students and staff with departments, levels and status.",
            },
            {
              icon: FileSpreadsheet,
              title: "Machine upload",
              body: "Excel or CSV exports read and stored row by row.",
            },
            {
              icon: CheckCircle2,
              title: "Automatic register",
              body: "Present, absent, out of scope and unmatched.",
            },
            {
              icon: ShieldCheck,
              title: "Controlled access",
              body: "Admin, operator and viewer permissions.",
            },
          ].map((item) => (
            <div
              key={item.title}
              className="panel p-5 group hover:shadow-lg transition-shadow duration-300 hover:-translate-y-1"
            >
              <div className="p-2 bg-primary/10 rounded-lg w-fit mb-3 group-hover:bg-primary/20 transition-colors">
                <item.icon className="size-5 text-primary" />
              </div>
              <h3 className="font-semibold">{item.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{item.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-20 grid gap-6 lg:grid-cols-3">
          <div className="panel p-6 group hover:shadow-xl transition-all duration-300 hover:-translate-y-1 border-primary/20">
            <Sparkles className="size-8 text-primary mb-4 group-hover:scale-110 transition-transform duration-300" />
            <h3 className="text-xl font-semibold mb-2">Student Management</h3>
            <p className="text-muted-foreground mb-4">
              Manage 8,760+ students with matric numbers, levels, departments, and categories.
              Automatic categorization from matric numbers.
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link to="/students">
                Manage Students <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
          </div>
          <div className="panel p-6 group hover:shadow-xl transition-all duration-300 hover:-translate-y-1 border-emerald-500/20">
            <Users className="size-8 text-emerald-600 mb-4 group-hover:scale-110 transition-transform duration-300" />
            <h3 className="text-xl font-semibold mb-2">Staff Management</h3>
            <p className="text-muted-foreground mb-4">
              Manage 800+ staff with faculty, department, and admin department assignments. Scan
              numbers derived from staff numbers.
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link to="/staff">
                Manage Staff <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
          </div>
          <div className="panel p-6 group hover:shadow-xl transition-all duration-300 hover:-translate-y-1 border-violet-500/20">
            <BarChart3 className="size-8 text-violet-600 mb-4 group-hover:scale-110 transition-transform duration-300" />
            <h3 className="text-xl font-semibold mb-2">Reports & Analytics</h3>
            <p className="text-muted-foreground mb-4">
              Daily, weekly, monthly reports with CSV export. Filter by department, level, category.
              Present/absent/unmatched breakdowns.
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link to="/reports/students">
                View Reports <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

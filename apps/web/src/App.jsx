import { AuthPanel } from "./components/AuthPanel.jsx";
import { AdminDashboard } from "./components/AdminDashboard.jsx";
import { SessionRoom } from "./components/SessionRoom.jsx";
import { useSessionStore } from "./store/session-store.js";

export default function App() {
  const sessionId = useSessionStore((state) => state.sessionId);
  const accessToken = useSessionStore((state) => state.accessToken);
  const isAdminRoute = typeof window !== "undefined" && window.location.pathname.startsWith("/admin");

  if (isAdminRoute) {
    return <AdminDashboard />;
  }

  if (!sessionId || !accessToken) {
    return <AuthPanel />;
  }

  return <SessionRoom />;
}

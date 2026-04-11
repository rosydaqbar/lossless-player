import { AuthPanel } from "./components/AuthPanel.jsx";
import { AdminDashboard } from "./components/AdminDashboard.jsx";
import { SessionRoom } from "./components/SessionRoom.jsx";
import { useSessionStore } from "./store/session-store.js";

export default function App() {
  const sessionId = useSessionStore((state) => state.sessionId);
  const accessToken = useSessionStore((state) => state.accessToken);
  const isAdminRoute = typeof window !== "undefined" && window.location.pathname.startsWith("/admin");
  let view = <SessionRoom />;
  let viewKey = "session";

  if (isAdminRoute) {
    view = <AdminDashboard />;
    viewKey = "admin";
  } else if (!sessionId || !accessToken) {
    view = <AuthPanel />;
    viewKey = "auth";
  }

  return <div key={viewKey} className="page-transition-in">{view}</div>;
}

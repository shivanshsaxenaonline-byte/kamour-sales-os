"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Viewer } from "@/types/crm";
interface ToastMessage {
  id: number;
  title: string;
  description?: string;
}
const ViewerContext = createContext<Viewer | null>(null);
const ToastContext = createContext<
  (title: string, description?: string) => void
>(() => {});
export function useViewer() {
  const value = useContext(ViewerContext);
  if (!value) throw new Error("CRM requires an authenticated viewer.");
  return value;
}
export function useToast() {
  return useContext(ToastContext);
}
export function CrmProvider({
  viewer,
  children,
}: {
  viewer: Viewer;
  children: React.ReactNode;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60000,
            gcTime: 300000,
            retry: 1,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
          },
        },
      }),
  );
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const sequence = useRef(0),
    timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const notify = useCallback((title: string, description?: string) => {
    const id = ++sequence.current;
    setMessages((previous) => [
      ...previous.slice(-2),
      { id, title, description },
    ]);
    timers.current.push(
      setTimeout(
        () => setMessages((previous) => previous.filter((m) => m.id !== id)),
        8000,
      ),
    );
  }, []);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      client.clear();
    },
    [client],
  );
  return (
    <QueryClientProvider client={client}>
      <ViewerContext.Provider value={viewer}>
        <ToastContext.Provider value={notify}>
          {children}
          <div className="crm-toasts" aria-live="polite" aria-atomic="false">
            {messages.map((message) => (
              <div className="crm-toast" key={message.id}>
                <button
                  className="icon-button toast-dismiss"
                  aria-label="Dismiss notification"
                  onClick={() =>
                    setMessages((previous) =>
                      previous.filter((m) => m.id !== message.id),
                    )
                  }
                >
                  ×
                </button>
                <strong>{message.title}</strong>
                {message.description ? <p>{message.description}</p> : null}
              </div>
            ))}
          </div>
        </ToastContext.Provider>
      </ViewerContext.Provider>
    </QueryClientProvider>
  );
}

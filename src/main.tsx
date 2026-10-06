// src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/geist";
import "./index.css";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { FeedbackProvider } from "./components/feedback";
import { supabaseConfigured } from "./lib/supabase";
import { watchTheme } from "./lib/theme";

watchTheme();

const Missing = () => (
  <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 480, margin: "10vh auto" }}>
    <h1 style={{ fontSize: 20, marginBottom: 8 }}>Supabase isn't configured</h1>
    <p>Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in <code>.env</code> (locally) or in your Vercel project settings, then restart or redeploy.</p>
  </div>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {supabaseConfigured
      ? <BrowserRouter><FeedbackProvider><AuthProvider><App /></AuthProvider></FeedbackProvider></BrowserRouter>
      : <Missing />}
  </React.StrictMode>
);

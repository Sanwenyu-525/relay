import React from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("missing root");
createRoot(root).render(<main data-testid="react-smoke">React compatibility probe</main>);

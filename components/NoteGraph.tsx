'use client';

import { useEffect, useRef, useState } from 'react';
import { Note } from '@/lib/types';

interface GraphNode {
  id: string;
  title: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface GraphEdge {
  source: string;
  target: string;
}

interface NoteGraphProps {
  notes: Note[];
  edges: GraphEdge[];
  onNodeClick?: (noteId: string) => void;
  activeNoteId?: string | null;
}

export default function NoteGraph({ notes, edges, onNodeClick, activeNoteId }: NoteGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.offsetWidth || 600;
    const h = canvas.offsetHeight || 400;

    const initialNodes: GraphNode[] = notes.map((n, i) => {
      const angle = (i / Math.max(notes.length, 1)) * 2 * Math.PI;
      const r = Math.min(w, h) * 0.3;
      return {
        id: n.id, title: n.title,
        x: w / 2 + Math.cos(angle) * r + (Math.random() - 0.5) * 30,
        y: h / 2 + Math.sin(angle) * r + (Math.random() - 0.5) * 30,
        vx: 0, vy: 0,
      };
    });

    setNodes(initialNodes);
  }, [notes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    for (const edge of edges) {
      const src = nodes.find((n) => n.id === edge.source);
      const tgt = nodes.find((n) => n.id === edge.target);
      if (!src || !tgt) continue;
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    for (const node of nodes) {
      const isActive = node.id === activeNoteId;
      const radius = isActive ? 10 : 7;

      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? '#3b82f6' : '#94a3b8';
      ctx.fill();

      if (isActive) {
        ctx.strokeStyle = '#bfdbfe';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.fillStyle = '#475569';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      const label = node.title.length > 16 ? node.title.slice(0, 16) + '…' : node.title;
      ctx.fillText(label, node.x, node.y + radius + 12);
    }
  }, [nodes, edges, activeNoteId]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onNodeClick) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    for (const node of nodes) {
      const dx = node.x - mx;
      const dy = node.y - my;
      if (Math.sqrt(dx * dx + dy * dy) < 12) {
        onNodeClick(node.id);
        return;
      }
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full cursor-pointer"
      onClick={handleClick}
    />
  );
}

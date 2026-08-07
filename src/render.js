import { SKELETON } from './config.js';

/* Overlay drawing. Kept cheap: no per-frame font measurement, no gradients,
   no shadows, and paths batched by colour so the number of state changes
   stays flat as players are added. */

const HANDLER = '#f5842a', OTHER = 'rgba(150,168,196,.55)';
const BALL = '#35d07f', BALL_GHOST = 'rgba(53,208,127,.35)';

export function drawFrame(ctx, canvas, poses, ball, engine, cfg, cal, t){
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (cal && cal.ready && cfg.drawDebug) drawCourt(ctx, cal);
  if (cfg.drawSkeleton){
    drawPoses(ctx, poses, engine.handlerId);
    if (ball.seen) drawBall(ctx, ball, t);
  }
}

function drawPoses(ctx, poses, handlerId){
  // Everyone else first, in one pass, so the handler always draws on top.
  ctx.lineWidth = 2;
  ctx.strokeStyle = OTHER;
  ctx.beginPath();
  for (const p of poses){
    if (p.id === handlerId) continue;
    addSkeletonPath(ctx, p);
  }
  ctx.stroke();

  const handler = poses.find(p => p.id === handlerId);
  if (handler){
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = HANDLER;
    ctx.beginPath();
    addSkeletonPath(ctx, handler);
    ctx.stroke();
  }

  ctx.font = '600 13px system-ui,sans-serif';
  ctx.textAlign = 'center';
  for (const p of poses){
    const head = p.kp('nose') || p.kp('left_shoulder') || p.kp('right_shoulder');
    if (!head || !p.id) continue;
    const isH = p.id === handlerId;
    const tag = 'P' + p.id;
    const w = tag.length * 9 + 10;
    ctx.fillStyle = isH ? 'rgba(245,132,42,.94)' : 'rgba(18,24,32,.74)';
    ctx.fillRect(head.x - w / 2, head.y - 32, w, 19);
    ctx.fillStyle = isH ? '#1a1005' : '#c3ccda';
    ctx.fillText(tag, head.x, head.y - 18.5);
  }
  ctx.textAlign = 'left';
}

function addSkeletonPath(ctx, p){
  for (let i = 0; i < SKELETON.length; i++){
    const a = p.kp(SKELETON[i][0]), b = p.kp(SKELETON[i][1]);
    if (!a || !b) continue;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
}

function drawBall(ctx, ball, t){
  const coasting = ball.isCoasting(t);
  ctx.strokeStyle = coasting ? BALL_GHOST : BALL;
  ctx.setLineDash(coasting ? [5, 4] : []);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, Math.max(ball.r, 8), 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawCourt(ctx, cal){
  if (!cal.points) return;
  ctx.strokeStyle = 'rgba(90,200,255,.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  cal.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = 'rgba(90,200,255,.9)';
  for (const p of cal.points){
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
  }
}

/* Calibration mode overlay: the points placed so far, plus guides. */
export function drawCalibration(ctx, canvas, pts, hoverIdx){
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(90,200,255,.85)';
  ctx.fillStyle = 'rgba(90,200,255,.95)';
  ctx.lineWidth = 2;
  if (pts.length > 1){
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    if (pts.length === 4) ctx.closePath();
    ctx.stroke();
  }
  ctx.font = '600 14px system-ui,sans-serif';
  ctx.textAlign = 'center';
  pts.forEach((p, i) => {
    ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#04121b';
    ctx.fillText(String(i + 1), p.x, p.y + 5);
    ctx.fillStyle = 'rgba(90,200,255,.95)';
  });
  ctx.textAlign = 'left';
}

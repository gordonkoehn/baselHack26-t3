"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Face, Persona, PersonaUpdate } from "@/lib/contracts";

/**
 * The uploaded photo, or initials. Preset previews (Simli's CDN) only load in the face picker,
 * so viewing a persona sends no request to a third party.
 */
export function FacePhoto({ persona, size = "size-16" }: { persona: Persona; size?: string }) {
  const src = persona.photoUrl;
  const [broken, setBroken] = useState<string | null>(null);
  const initials = persona.name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
  if (src && broken !== src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- small avatar, no optimisation needed
      <img
        src={src}
        alt={`Picture of ${persona.name}`}
        className={`${size} shrink-0 rounded-full object-cover`}
        onError={() => setBroken(src)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${size} flex shrink-0 items-center justify-center rounded-full bg-accent-soft text-xl font-semibold text-accent`}
    >
      {initials}
    </span>
  );
}

const field = "w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm";

// A profile picture needs no more than 512 px; this also keeps phone photos far below the 2 MB cap.
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas"))), "image/jpeg", 0.9),
  );
}

const POLL_MS = 15_000;

/**
 * Where Simli is with turning the photo into the call face. Polls while it's building, so the
 * status moves on by itself; it can take several minutes.
 */
export function CustomFaceStatus({ persona, onPersona }: { persona: Persona; onPersona: (p: Persona) => void }) {
  const custom = persona.customFace;
  const building = custom?.status === "pending" || custom?.status === "processing";
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Polls only while building; onPersona from the latest render, so an edit in between isn't lost.
  const latest = useRef(onPersona);
  useEffect(() => {
    latest.current = onPersona;
  });
  useEffect(() => {
    if (!building) return;
    const id = setInterval(() => {
      api.refreshFace(persona.id).then((p) => latest.current(p), () => {});
    }, POLL_MS);
    return () => clearInterval(id);
  }, [building, persona.id]);

  if (!custom) return null;
  // Simli only reports dispatchAfter while the generation still waits for its slot.
  const starts = custom.status === "pending" && custom.dispatchAfter ? new Date(custom.dispatchAfter * 1000) : null;
  const text =
    custom.status === "completed"
      ? persona.faceId === custom.faceId
        ? "The call shows the person in the photo."
        : "The face from the photo is ready; pick it under “Face in the call”."
      : custom.status === "failed"
        ? "Simli couldn't build a face from this photo."
        : starts
          ? `Simli builds the call face from the photo, starting about ${starts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Until then the call uses the preset face.`
          : "Simli is building the call face from the photo (a few minutes). Until then the call uses the preset face.";
  return (
    <div className="text-sm" role="status">
      <span className={custom.status === "failed" ? "text-red-700 dark:text-red-300" : "text-muted"}>
        {building && <span aria-hidden className="mr-1.5 inline-block size-2 animate-pulse rounded-full bg-accent" />}
        {text}
      </span>
      {custom.status === "failed" && (
        <button
          type="button"
          className="ml-2 underline disabled:opacity-40"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            setError(null);
            try {
              onPersona(await api.startFace(persona.id));
            } catch (e) {
              setError(faceError(e));
            } finally {
              setRetrying(false);
            }
          }}
        >
          Try again
        </button>
      )}
      {error && <span className="ml-2 text-red-700 dark:text-red-300">{error}</span>}
    </div>
  );
}

function faceError(e: unknown): string {
  if (e instanceof ApiError && (e.status === 409 || e.status === 422)) return e.detail;
  return "Simli isn't reachable right now. Try again in a moment.";
}

/** Upload or remove the persona's own picture. It applies at once, apart from Save. */
function PhotoUpload({
  persona,
  onPersona,
  upload,
  remove,
}: {
  persona: Persona;
  onPersona: (p: Persona) => void;
  upload: (image: Blob) => Promise<Persona>;
  remove: () => Promise<Persona>;
}) {
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<Persona>) {
    setBusy(true);
    setError(null);
    try {
      onPersona(await action());
    } catch {
      setError("That didn't work. Use a PNG, JPEG or WebP photo and try again.");
    } finally {
      setBusy(false);
    }
  }

  // The photo is kept even if Simli refuses it; then only the app shows it.
  async function uploadAndBuild(image: Blob) {
    setBusy(true);
    setError(null);
    try {
      onPersona(await upload(image));
    } catch {
      setError("That didn't work. Use a PNG, JPEG or WebP photo and try again.");
      setBusy(false);
      return;
    }
    try {
      onPersona(await api.startFace(persona.id));
    } catch (e) {
      setError(`Photo saved, but no call face: ${faceError(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">Profile picture</legend>
      <div className="flex flex-wrap items-center gap-4">
        <FacePhoto persona={persona} size="size-16" />
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} />
            I may use this picture, and the person in it agreed to become a talking AI avatar
          </label>
          <div className="flex flex-wrap gap-2">
            <label
              className={`rounded-md border border-line px-3 py-1.5 focus-within:outline-2 focus-within:outline-accent ${
                allowed && !busy ? "cursor-pointer hover:border-muted" : "pointer-events-none opacity-40"
              }`}
            >
              {busy ? "Uploading…" : "Upload photo…"}
              <input
                type="file"
                accept=".png,.jpg,.jpeg,.webp"
                className="sr-only"
                disabled={!allowed || busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) shrink(file).then(uploadAndBuild, () => setError("That file couldn't be read as an image."));
                }}
              />
            </label>
            {persona.photoUrl && (
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-muted hover:text-foreground"
                onClick={() => run(remove)}
                disabled={busy}
              >
                Remove photo
              </button>
            )}
          </div>
          <p className="text-muted">
            Simli turns the photo into the face in the call. That takes a few minutes and uses one of the
            account&apos;s avatar generations.
          </p>
          <CustomFaceStatus persona={persona} onPersona={onPersona} />
          {error && (
            <p role="alert" className="text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
        </div>
      </div>
    </fieldset>
  );
}

/** Edit who the persona is: name, basics, backstory and the face (which also sets the voice). */
export function IdentityEditor({
  persona,
  faces,
  onSave,
  onCancel,
  onPersona,
}: {
  persona: Persona;
  faces: Face[];
  onSave: (update: PersonaUpdate) => Promise<void>;
  onCancel: () => void;
  /** A photo upload or removal, which saves on its own. */
  onPersona: (p: Persona) => void;
}) {
  const [name, setName] = useState(persona.name);
  const [age, setAge] = useState(persona.age?.toString() ?? "");
  const [location, setLocation] = useState(persona.location ?? "");
  const [job, setJob] = useState(persona.context?.job ?? "");
  const [household, setHousehold] = useState(persona.context?.household ?? "");
  const [summary, setSummary] = useState(persona.summary);
  // null = untouched: Simli may switch the face while the editor is open, and Save mustn't undo that.
  const [pickedFace, setPickedFace] = useState<string | null>(null);
  const [pickedVoice, setPickedVoice] = useState<"marin" | "cedar" | null>(null);
  const faceId = pickedFace ?? persona.faceId;
  const voiceId = pickedVoice ?? persona.voiceId;
  const custom = persona.customFace?.status === "completed" ? persona.customFace : null;
  const [saving, setSaving] = useState(false);
  const ageNumber = age.trim() === "" ? null : Number(age);
  const valid = name.trim() !== "" && summary.trim() !== "" && (ageNumber === null || (Number.isInteger(ageNumber) && ageNumber >= 0 && ageNumber <= 120));

  async function save() {
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        age: ageNumber,
        location: location.trim() || null,
        summary: summary.trim(),
        context: { ...persona.context, job: job.trim() || null, household: household.trim() || null },
        ...(pickedFace && pickedFace !== persona.faceId ? { faceId: pickedFace } : {}),
        // After the face, so a voice picked here wins over the one a preset face brings.
        ...(pickedVoice && pickedVoice !== persona.voiceId ? { voiceId: pickedVoice } : {}),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !saving) save();
      }}
    >
      <PhotoUpload
        persona={persona}
        onPersona={onPersona}
        upload={(image) => api.uploadPhoto(persona.id, image)}
        remove={() => api.removePhoto(persona.id)}
      />

      <fieldset>
        <legend className="mb-2 text-sm font-medium">Face in the call</legend>
        <p className="mb-2 text-sm text-muted">The talking avatar. The voice follows the face.</p>
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
          {custom && persona.photoUrl && (
            <label className="cursor-pointer" title="Made from the uploaded photo">
              <input
                type="radio"
                name="face"
                value={custom.faceId}
                checked={faceId === custom.faceId}
                onChange={() => setPickedFace(custom.faceId)}
                className="peer sr-only"
              />
              {/* eslint-disable-next-line @next/next/no-img-element -- uploaded photo */}
              <img
                src={persona.photoUrl}
                alt="Face made from the uploaded photo"
                className="aspect-square w-full rounded-lg object-cover opacity-70 ring-accent peer-checked:opacity-100 peer-checked:ring-2 peer-focus-visible:ring-2 hover:opacity-100"
              />
            </label>
          )}
          {faces.map((f) => (
            <label key={f.id} className="cursor-pointer" title={f.look}>
              <input
                type="radio"
                name="face"
                value={f.id}
                checked={faceId === f.id}
                onChange={() => {
                  setPickedFace(f.id);
                  // A preset face brings its own voice, like on the server.
                  setPickedVoice(f.gender === "f" ? "marin" : "cedar");
                }}
                className="peer sr-only"
              />
              {/* eslint-disable-next-line @next/next/no-img-element -- remote preset preview */}
              <img
                src={f.photoUrl}
                alt={`${f.name}: ${f.look}`}
                className="aspect-square w-full rounded-lg object-cover opacity-70 ring-accent peer-checked:opacity-100 peer-checked:ring-2 peer-focus-visible:ring-2 hover:opacity-100"
              />
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-wrap items-center gap-4 text-sm">
        <legend className="sr-only">Voice</legend>
        <span className="font-medium">Voice</span>
        {(
          [
            ["marin", "Female"],
            ["cedar", "Male"],
          ] as const
        ).map(([id, label]) => (
          <label key={id} className="flex items-center gap-1.5">
            <input type="radio" name="voice" checked={voiceId === id} onChange={() => setPickedVoice(id)} />
            {label}
          </label>
        ))}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Name
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </label>
        <label className="text-sm">
          Age
          <input className={field} inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value)} placeholder="unknown" />
        </label>
        <label className="text-sm">
          Location
          <input className={field} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={120} />
        </label>
        <label className="text-sm">
          Job
          <input className={field} value={job} onChange={(e) => setJob(e.target.value)} />
        </label>
        <label className="text-sm sm:col-span-2">
          Household
          <input className={field} value={household} onChange={(e) => setHousehold(e.target.value)} />
        </label>
        <label className="text-sm sm:col-span-2">
          Backstory
          <textarea className={`${field} h-28`} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={4000} required />
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-40"
          disabled={!valid || saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="rounded-md px-3 py-2 text-sm text-muted hover:text-foreground" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

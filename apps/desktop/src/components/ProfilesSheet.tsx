import { For, Index, Show, createEffect, createMemo, createSignal, on, onMount, type Accessor, type JSX } from "solid-js";
import type { ProfileView } from "@gentle-shell/protocol";
import { THINKING_LEVELS, TIERS, addRoute, draftRoutes, isDirty, removeRoute, toDraft, updateRoute, type ProfileDraft } from "../lib/profiles";
import type { ProfilesPanel } from "../state/profiles";
import { Sheet } from "./Sheets";
import { SkeletonLines } from "./Skeleton";

type Naming = { kind: "create" | "duplicate" | "rename"; value: string } | null;

const NAMING_LABEL = { create: "New profile", duplicate: "Copy as", rename: "Rename to" } as const;

/**
 * Manage Gentle Shell's agent-model profiles, the job the terminal does with a fullscreen screen.
 *
 * It edits what the bridge reads from `profiles.json`, so every button is a real change to that file and
 * every answer is the file as it now is. "Use for new threads" makes a profile the default and opens a
 * thread that starts with it: a thread that is already open keeps the profile it started with, because
 * only Pi's own process can rebind a running session.
 */
export function ProfilesSheet(props: {
	panel: ProfilesPanel;
	models: Accessor<ReadonlyArray<{ provider: string; id: string }>>;
	onLoadModels: () => void;
	onClose: () => void;
}): JSX.Element {
	const view = () => props.panel.view();
	const data = () => view().data;
	const selected = createMemo<ProfileView | null>(() => data()?.profiles.find((profile) => profile.name === view().selected) ?? null);

	const [draft, setDraft] = createSignal<ProfileDraft | null>(null);
	const [naming, setNaming] = createSignal<Naming>(null);
	const [confirmDelete, setConfirmDelete] = createSignal(false);
	const [agentToAdd, setAgentToAdd] = createSignal("");

	// A different profile, or a fresh answer for this one, starts the editor over from what is stored.
	createEffect(
		on(selected, (profile) => {
			setDraft(profile === null ? null : toDraft(profile));
			setConfirmDelete(false);
			setNaming(null);
			setAgentToAdd("");
		}),
	);

	onMount(() => {
		if (props.models().length === 0) props.onLoadModels();
	});

	const dirty = (): boolean => {
		const profile = selected();
		const current = draft();
		return profile !== null && current !== null && isDirty(profile, current);
	};
	const addable = (): string[] => (data()?.agents ?? []).filter((agent) => !(draft()?.routes ?? []).some((route) => route.agent === agent));

	function edit(change: (current: ProfileDraft) => ProfileDraft): void {
		setDraft((current) => (current === null ? current : change(current)));
	}

	async function submitNaming(): Promise<void> {
		const asked = naming();
		const value = asked?.value.trim() ?? "";
		if (asked === null || value.length === 0) return;
		const from = selected()?.name;
		if (asked.kind === "create") await props.panel.create(value);
		else if (from !== undefined && asked.kind === "duplicate") await props.panel.create(value, from);
		else if (from !== undefined) await props.panel.rename(from, value);
		if (view().error === null) setNaming(null);
	}

	async function save(): Promise<void> {
		const current = draft();
		if (current === null) return;
		await props.panel.save(current.name, draftRoutes(current), current.mode);
	}

	async function remove(): Promise<void> {
		const name = selected()?.name;
		setConfirmDelete(false);
		if (name !== undefined) await props.panel.remove(name);
	}

	return (
		<Sheet title="Profiles" wide onClose={props.onClose}>
			<Show
				when={data()}
				fallback={
					<Show when={view().error === null} fallback={<p class="inspector-error">{view().error}</p>}>
						<SkeletonLines count={7} label="Reading profiles" />
					</Show>
				}
			>
				{(loaded) => (
					<Show
						when={loaded().state === "ok"}
						fallback={
							<>
								<p class="inspector-error">{loaded().message}</p>
								<p class="muted">
									Profiles are read from <code>{loaded().configHome}</code>.
								</p>
							</>
						}
					>
						<datalist id="profile-models">
							<For each={props.models()}>{(model) => <option value={`${model.provider}/${model.id}`} />}</For>
						</datalist>
						<datalist id="profile-agents">
							<For each={addable()}>{(agent) => <option value={agent} />}</For>
						</datalist>

						<Show when={loaded().notes.length > 0}>
							<ul class="profile-notes">
								<For each={loaded().notes}>{(note) => <li>{note}</li>}</For>
							</ul>
						</Show>

						<div class="profiles-layout">
							<nav class="profiles-list" aria-label="Profiles">
								<For each={loaded().profiles} fallback={<p class="muted">No profiles yet.</p>}>
									{(profile) => (
										<button
											type="button"
											class="profile-item"
											classList={{ on: profile.name === view().selected }}
											onClick={() => props.panel.select(profile.name)}
										>
											<span class="profile-name">{profile.name}</span>
											<Show when={profile.active}>
												<span class="profile-badge">default</span>
											</Show>
											<Show when={loaded().effective?.source !== "active" && loaded().effective?.name === profile.name}>
												<span class="profile-badge pin">pinned here</span>
											</Show>
										</button>
									)}
								</For>
								<button
									type="button"
									class="choice"
									disabled={view().busy}
									onClick={() => setNaming({ kind: "create", value: "" })}
								>
									+ New profile
								</button>
							</nav>

							<section class="profiles-detail" aria-label="Profile details">
								<Show when={naming()}>
									{(asked) => (
										<div class="profile-naming">
											<label>
												<span class="muted">{NAMING_LABEL[asked().kind]}</span>
												<input
													class="text-input"
													value={asked().value}
													placeholder="letters, numbers, . _ -"
													ref={(element) => queueMicrotask(() => element.focus())}
													onInput={(event) => setNaming({ ...asked(), value: event.currentTarget.value })}
													onKeyDown={(event) => {
														if (event.isComposing) return;
														if (event.key === "Enter") void submitNaming();
														if (event.key === "Escape") setNaming(null);
													}}
												/>
											</label>
											<button type="button" class="choice primary" disabled={view().busy} onClick={() => void submitNaming()}>
												OK
											</button>
											<button type="button" class="choice cancel" onClick={() => setNaming(null)}>
												Cancel
											</button>
										</div>
									)}
								</Show>

								<Show when={selected()} fallback={<p class="muted">Pick a profile, or create one.</p>}>
									{(profile) => (
										<>
											<header class="profile-head">
												<h3>{profile().name}</h3>
												<div class="profile-actions">
													<button
														type="button"
														class="choice"
														disabled={view().busy}
														onClick={() => setNaming({ kind: "duplicate", value: `${profile().name}-copy` })}
													>
														Duplicate
													</button>
													<button
														type="button"
														class="choice"
														disabled={view().busy}
														onClick={() => setNaming({ kind: "rename", value: profile().name })}
													>
														Rename
													</button>
													<Show
														when={confirmDelete()}
														fallback={
															<button type="button" class="choice" disabled={view().busy} onClick={() => setConfirmDelete(true)}>
																Delete
															</button>
														}
													>
														<button type="button" class="choice danger" disabled={view().busy} onClick={() => void remove()}>
															Delete {profile().name}?
														</button>
													</Show>
													<button
														type="button"
														class="choice primary"
														disabled={view().busy || dirty()}
														title={dirty() ? "Save your changes first" : "Make it the default and open a new thread with it"}
														onClick={() => void props.panel.use(profile().name)}
													>
														Use for new threads
													</button>
												</div>
											</header>

											<Show when={draft()}>
												{(current) => (
													<>
														<label class="profile-mode">
															<span class="muted">Orchestrator mode</span>
															<select
																class="profile-select"
																onChange={(event) => edit((value) => ({ ...value, mode: event.currentTarget.value === "full-delegation" ? "full-delegation" : "organic" }))}
															>
																<option value="organic" selected={current().mode === "organic"}>
																	organic: may implement inline
																</option>
																<option value="full-delegation" selected={current().mode === "full-delegation"}>
																	full-delegation: delegates all implementation
																</option>
															</select>
														</label>

														<div class="profile-routes" role="table" aria-label={`Routes of ${profile().name}`}>
															<div class="profile-route head" role="row">
																<span>agent</span>
																<span>model</span>
																<span>thinking</span>
																<span>tier</span>
																<span />
															</div>
															<Index each={current().routes} fallback={<p class="muted">This profile routes no agent yet.</p>}>
																{(route) => (
																	<div class="profile-route" role="row">
																		<span class="mono agent">{route().agent}</span>
																		<input
																			class="text-input"
																			list="profile-models"
																			value={route().model}
																			placeholder="provider/model"
																			aria-label={`Model for ${route().agent}`}
																			onInput={(event) => edit((value) => updateRoute(value, route().agent, { model: event.currentTarget.value }))}
																		/>
																		<select
																			class="profile-select"
																			aria-label={`Thinking level for ${route().agent}`}
																			onChange={(event) => edit((value) => updateRoute(value, route().agent, { thinking: event.currentTarget.value }))}
																		>
																			<option value="" selected={route().thinking === ""}>
																				—
																			</option>
																			<For each={THINKING_LEVELS}>
																				{(level) => (
																					<option value={level} selected={route().thinking === level}>
																						{level}
																					</option>
																				)}
																			</For>
																		</select>
																		<select
																			class="profile-select"
																			aria-label={`Tier for ${route().agent}`}
																			onChange={(event) => edit((value) => updateRoute(value, route().agent, { tier: event.currentTarget.value }))}
																		>
																			<option value="" selected={route().tier === ""}>
																				—
																			</option>
																			<For each={TIERS}>
																				{(tier) => (
																					<option value={tier} selected={route().tier === tier}>
																						{tier}
																					</option>
																				)}
																			</For>
																		</select>
																		<button
																			type="button"
																			class="icon-btn"
																			title={`Remove ${route().agent}`}
																			aria-label={`Remove ${route().agent}`}
																			onClick={() => edit((value) => removeRoute(value, route().agent))}
																		>
																			✕
																		</button>
																	</div>
																)}
															</Index>
														</div>

														<div class="profile-add">
															<input
																class="text-input"
																list="profile-agents"
																value={agentToAdd()}
																placeholder="Add an agent"
																aria-label="Agent to add"
																onInput={(event) => setAgentToAdd(event.currentTarget.value)}
																onKeyDown={(event) => {
																	if (event.isComposing || event.key !== "Enter") return;
																	edit((value) => addRoute(value, agentToAdd()));
																	setAgentToAdd("");
																}}
															/>
															<button
																type="button"
																class="choice"
																disabled={agentToAdd().trim().length === 0}
																onClick={() => {
																	edit((value) => addRoute(value, agentToAdd()));
																	setAgentToAdd("");
																}}
															>
																Add
															</button>
														</div>

														<footer class="profile-footer">
															<button type="button" class="choice primary" disabled={!dirty() || view().busy} onClick={() => void save()}>
																Save
															</button>
															<button
																type="button"
																class="choice cancel"
																disabled={!dirty()}
																onClick={() => setDraft(toDraft(profile()))}
															>
																Revert
															</button>
															<Show when={dirty()}>
																<span class="muted">Unsaved changes</span>
															</Show>
														</footer>
													</>
												)}
											</Show>
										</>
									)}
								</Show>

								<Show when={view().error}>{(error) => <p class="inspector-error">{error()}</p>}</Show>
								<Show when={view().notice}>{(notice) => <p class="profile-notice">{notice()}</p>}</Show>
							</section>
						</div>
					</Show>
				)}
			</Show>
		</Sheet>
	);
}

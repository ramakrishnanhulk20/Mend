"""Render Workflows entry point: one thin task per engine job in mend_engine.tasks.

Render builds this folder and runs `python main.py`; app.start() reads the
RENDER_SDK_MODE that Render sets, so the file is never run bare. Every check and
all the logic live in mend_engine/tasks.py, which the local dev bridge calls the
same way, so what runs locally is what runs on Render. Arguments arrive as JSON
from the web app and are typed as object because the tasks check them.
"""

from render import Retry, TaskContext, Workflows

from mend_engine import tasks

# Anything that writes gets no Render retries: a rerun repeats the work, and for
# money it is PayPal's sender_batch_id, never a blind retry, that keeps a payout
# single (C3). A task that crashed is looked at, not rerun.
NO_RETRY = Retry(max_retries=0, wait_duration_ms=1000)
# Reads change nothing, so running one again is safe.
READ_RETRY = Retry(max_retries=2, wait_duration_ms=1000, backoff_scaling=2.0)
TIMEOUT_SECONDS = 300

app = Workflows(default_retry=NO_RETRY, default_timeout=TIMEOUT_SECONDS, default_plan="flex")


@app.task(retry=NO_RETRY)
def draft_campaign(ctx: TaskContext, settings: object, actor: object) -> dict:
    return tasks.draft_campaign(settings, actor)


@app.task(retry=READ_RETRY)
def view_campaign(ctx: TaskContext, campaign_id: object, actor: object) -> dict:
    return tasks.view_campaign(campaign_id, actor)


@app.task(retry=NO_RETRY)
def approve_campaign(ctx: TaskContext, campaign_id: object, actor: object, presented_hash: object) -> dict:
    return tasks.approve_campaign(campaign_id, actor, presented_hash)


@app.task(retry=NO_RETRY)
def submit_campaign(ctx: TaskContext, campaign_id: object, actor: object) -> dict:
    return tasks.submit_campaign(campaign_id, actor)


@app.task(retry=NO_RETRY)
def simulate_return(ctx: TaskContext, campaign_id: object, ref: object, actor: object) -> dict:
    return tasks.simulate_return(campaign_id, ref, actor)


@app.task(retry=READ_RETRY)
def results(ctx: TaskContext, campaign_id: object, actor: object) -> dict:
    return tasks.results(campaign_id, actor)


@app.task(retry=READ_RETRY)
def shop_summary(ctx: TaskContext) -> dict:
    return tasks.shop_summary()


@app.task(retry=READ_RETRY)
def quiet_regulars(ctx: TaskContext, actor: object, limit: object) -> dict:
    return tasks.quiet_regulars(actor, limit)


@app.task(retry=NO_RETRY)
def process_events(ctx: TaskContext) -> dict:
    return tasks.process_events()


@app.task(retry=NO_RETRY)
def reconcile(ctx: TaskContext) -> dict:
    return tasks.reconcile()


@app.task(retry=NO_RETRY)
def purge(ctx: TaskContext) -> dict:
    return tasks.purge()


@app.task(retry=READ_RETRY)
def draft_limits(ctx: TaskContext, actor: object) -> dict:
    return tasks.draft_limits(actor)


@app.task(retry=READ_RETRY)
def note_context(ctx: TaskContext, campaign_id: object, ref: object, actor: object) -> dict:
    return tasks.note_context(campaign_id, ref, actor)


@app.task(retry=NO_RETRY)
def set_note(ctx: TaskContext, campaign_id: object, ref: object, note: object, actor: object) -> dict:
    return tasks.set_note(campaign_id, ref, note, actor)


@app.task(retry=NO_RETRY)
def request_approval(ctx: TaskContext, campaign_id: object, actor: object) -> dict:
    return tasks.request_approval(campaign_id, actor)


if __name__ == "__main__":
    app.start()

import './adDialog.css';

export interface AdDialogContent {
  title: string;
  description: string;
  primary?: { label: string; activate: (event: Event) => void };
  secondary?: { label: string; activate: () => void };
}

export class AdDialog {
  readonly element: HTMLDialogElement;
  private readonly title: HTMLHeadingElement;
  private readonly description: HTMLParagraphElement;
  private readonly primary: HTMLButtonElement;
  private readonly secondary: HTMLButtonElement;
  private content: AdDialogContent | null = null;

  constructor(document: Document) {
    this.element = document.createElement('dialog');
    this.element.className = 'game-ad-dialog';
    this.title = document.createElement('h2');
    this.title.id = 'game-ad-title';
    this.description = document.createElement('p');
    this.description.id = 'game-ad-description';
    this.element.setAttribute('aria-labelledby', this.title.id);
    this.element.setAttribute('aria-describedby', this.description.id);
    this.description.setAttribute('aria-live', 'polite');
    this.primary = document.createElement('button');
    this.secondary = document.createElement('button');
    this.primary.type = this.secondary.type = 'button';
    const actions = document.createElement('div');
    actions.className = 'game-ad-actions';
    actions.append(this.primary, this.secondary);
    this.element.append(this.title, this.description, actions);
    document.body.append(this.element);

    this.primary.addEventListener('click', event => this.content?.primary?.activate(event));
    this.secondary.addEventListener('click', () => this.content?.secondary?.activate());
    this.element.addEventListener('cancel', event => {
      event.preventDefault();
      this.content?.secondary?.activate();
    });
  }

  show(content: AdDialogContent): void {
    if (this.content === content) return;
    this.content = content;
    this.title.textContent = content.title;
    this.description.textContent = content.description;
    this.primary.textContent = content.primary?.label ?? '';
    this.primary.hidden = !content.primary;
    this.secondary.textContent = content.secondary?.label ?? '';
    this.secondary.hidden = !content.secondary;
    if (!this.element.open) this.element.showModal();
    if (content.secondary) this.secondary.focus();
    else if (content.primary) this.primary.focus();
    else this.element.focus();
  }

  hide(): void {
    this.content = null;
    if (this.element.open) this.element.close();
  }

  destroy(): void {
    this.hide();
    this.element.remove();
  }
}

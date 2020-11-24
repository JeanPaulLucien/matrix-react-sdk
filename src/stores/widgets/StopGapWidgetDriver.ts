/*
 * Copyright 2020 The Matrix.org Foundation C.I.C.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    Capability,
    IOpenIDCredentials,
    IOpenIDUpdate,
    ISendEventDetails,
    MatrixCapabilities,
    OpenIDRequestState,
    SimpleObservable,
    Widget,
    WidgetDriver,
    WidgetKind,
} from "matrix-widget-api";
import { iterableDiff, iterableUnion } from "../../utils/iterables";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import ActiveRoomObserver from "../../ActiveRoomObserver";
import Modal from "../../Modal";
import WidgetUtils from "../../utils/WidgetUtils";
import SettingsStore from "../../settings/SettingsStore";
import WidgetOpenIDPermissionsDialog from "../../components/views/dialogs/WidgetOpenIDPermissionsDialog";
import WidgetCapabilitiesPromptDialog, {
    getRememberedCapabilitiesForWidget,
} from "../../components/views/dialogs/WidgetCapabilitiesPromptDialog";
import { WidgetPermissionCustomisations } from "../../customisations/WidgetPermissions";

// TODO: Purge this from the universe

export class StopGapWidgetDriver extends WidgetDriver {
    private allowedCapabilities: Set<Capability>;

    // TODO: Refactor widgetKind into the Widget class
    constructor(allowedCapabilities: Capability[], private forWidget: Widget, private forWidgetKind: WidgetKind) {
        super();

        // Always allow screenshots to be taken because it's a client-induced flow. The widget can't
        // spew screenshots at us and can't request screenshots of us, so it's up to us to provide the
        // button if the widget says it supports screenshots.
        this.allowedCapabilities = new Set([...allowedCapabilities, MatrixCapabilities.Screenshots]);
    }

    public async validateCapabilities(requested: Set<Capability>): Promise<Set<Capability>> {
        // Check to see if any capabilities aren't automatically accepted (such as sticker pickers
        // allowing stickers to be sent). If there are excess capabilities to be approved, the user
        // will be prompted to accept them.
        const diff = iterableDiff(requested, this.allowedCapabilities);
        const missing = new Set(diff.removed); // "removed" is "in A (requested) but not in B (allowed)"
        const allowedSoFar = new Set(this.allowedCapabilities);
        getRememberedCapabilitiesForWidget(this.forWidget).forEach(cap => {
            allowedSoFar.add(cap);
            missing.delete(cap);
        });
        if (WidgetPermissionCustomisations.preapproveCapabilities) {
            const approved = await WidgetPermissionCustomisations.preapproveCapabilities(this.forWidget, requested);
            if (approved) {
                approved.forEach(cap => {
                    allowedSoFar.add(cap);
                    missing.delete(cap);
                });
            }
        }
        // TODO: Do something when the widget requests new capabilities not yet asked for
        if (missing.size > 0) {
            try {
                const [result] = await Modal.createTrackedDialog(
                    'Approve Widget Caps', '',
                    WidgetCapabilitiesPromptDialog,
                    {
                        requestedCapabilities: missing,
                        widget: this.forWidget,
                        widgetKind: this.forWidgetKind,
                    }).finished;
                (result.approved || []).forEach(cap => allowedSoFar.add(cap));
            } catch (e) {
                console.error("Non-fatal error getting capabilities: ", e);
            }
        }

        return new Set(iterableUnion(allowedSoFar, requested));
    }

    public async sendEvent(eventType: string, content: any, stateKey: string = null): Promise<ISendEventDetails> {
        const client = MatrixClientPeg.get();
        const roomId = ActiveRoomObserver.activeRoomId;

        if (!client || !roomId) throw new Error("Not in a room or not attached to a client");

        let r: { event_id: string } = null; // eslint-disable-line camelcase
        if (stateKey !== null) {
            // state event
            r = await client.sendStateEvent(roomId, eventType, content, stateKey);
        } else {
            // message event
            r = await client.sendEvent(roomId, eventType, content);
        }

        return {roomId, eventId: r.event_id};
    }

    public async askOpenID(observer: SimpleObservable<IOpenIDUpdate>) {
        const isUserWidget = this.forWidgetKind !== WidgetKind.Room; // modal and account widgets are "user" widgets
        const rawUrl = this.forWidget.templateUrl;
        const widgetSecurityKey = WidgetUtils.getWidgetSecurityKey(this.forWidget.id, rawUrl, isUserWidget);

        const getToken = (): Promise<IOpenIDCredentials> => {
            return MatrixClientPeg.get().getOpenIdToken();
        };

        const settings = SettingsStore.getValue("widgetOpenIDPermissions");
        if (settings?.deny?.includes(widgetSecurityKey)) {
            return observer.update({state: OpenIDRequestState.Blocked});
        }
        if (settings?.allow?.includes(widgetSecurityKey)) {
            return observer.update({state: OpenIDRequestState.Allowed, token: await getToken()});
        }

        observer.update({state: OpenIDRequestState.PendingUserConfirmation});

        Modal.createTrackedDialog("OpenID widget permissions", '', WidgetOpenIDPermissionsDialog, {
            widgetUrl: rawUrl,
            widgetId: this.forWidget.id,
            isUserWidget: isUserWidget,

            onFinished: async (confirm) => {
                if (!confirm) {
                    return observer.update({state: OpenIDRequestState.Blocked});
                }

                return observer.update({state: OpenIDRequestState.Allowed, token: await getToken()});
            },
        });
    }
}

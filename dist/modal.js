import * as React from 'react';
import {
  Animated,
  DeviceEventEmitter,
  Dimensions,
  InteractionManager,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  BackHandler,
  Platform,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import * as PropTypes from 'prop-types';
import * as animatable from 'react-native-animatable';
import {
  initializeAnimations,
  buildAnimations,
  reversePercentage,
} from './utils';
import styles from './modal.style';
// Override default react-native-animatable animations
initializeAnimations();
const defaultProps = {
  animationIn: 'slideInUp',
  animationInTiming: 300,
  animationOut: 'slideOutDown',
  animationOutTiming: 300,
  avoidKeyboard: false,
  coverScreen: true,
  hasBackdrop: true,
  backdropColor: 'black',
  backdropOpacity: 0.7,
  backdropTransitionInTiming: 300,
  backdropTransitionOutTiming: 300,
  customBackdrop: null,
  useNativeDriver: false,
  deviceHeight: null,
  deviceWidth: null,
  hideModalContentWhileAnimating: false,
  propagateSwipe: false,
  isVisible: false,
  panResponderThreshold: 4,
  swipeThreshold: 100,
  onModalShow: () => null,
  onModalWillShow: () => null,
  onModalHide: () => null,
  onModalWillHide: () => null,
  onBackdropPress: () => null,
  onBackButtonPress: () => null,
  scrollTo: null,
  scrollOffset: 0,
  scrollOffsetMax: 0,
  scrollHorizontal: false,
  statusBarTranslucent: false,
  supportedOrientations: ['portrait', 'landscape'],
};
const extractAnimationFromProps = props => ({
  animationIn: props.animationIn,
  animationOut: props.animationOut,
});
export class ReactNativeModal extends React.Component {
  constructor(props) {
    super(props);
    // We use an internal state for keeping track of the modal visibility: this allows us to keep
    // the modal visible during the exit animation, even if the user has already change the
    // isVisible prop to false.
    // We store in the state the device width and height so that we can update the modal on
    // device rotation.
    this.state = {
      showContent: true,
      isVisible: false,
      deviceWidth: Dimensions.get('window').width,
      deviceHeight: Dimensions.get('window').height,
      isSwipeable: !!this.props.swipeDirection,
      pan: null,
    };
    this.isTransitioning = false;
    this.inSwipeClosingState = false;
    this.currentSwipingDirection = null;
    this.panResponder = null;
    this.didUpdateDimensionsEmitter = null;
    this.backHandlerEventSubscription = null;
    this.interactionHandle = null;
    this.getDeviceHeight = () =>
      this.props.deviceHeight || this.state.deviceHeight;
    this.getDeviceWidth = () =>
      this.props.deviceWidth || this.state.deviceWidth;
    this.onBackButtonPress = () => {
      if (this.props.onBackButtonPress && this.props.isVisible) {
        this.props.onBackButtonPress();
        return true;
      }
      return false;
    };
    this.shouldPropagateSwipe = (evt, gestureState) => {
      return typeof this.props.propagateSwipe === 'function'
        ? this.props.propagateSwipe(evt, gestureState)
        : this.props.propagateSwipe;
    };
    this.buildPanResponder = () => {
      let animEvt = null;
      this.panResponder = PanResponder.create({
        onMoveShouldSetPanResponder: (evt, gestureState) => {
          // Use propagateSwipe to allow inner content to scroll. See PR:
          // https://github.com/react-native-community/react-native-modal/pull/246
          if (!this.shouldPropagateSwipe(evt, gestureState)) {
            // The number "4" is just a good tradeoff to make the panResponder
            // work correctly even when the modal has touchable buttons.
            // However, if you want to overwrite this and choose for yourself,
            // set panResponderThreshold in the props.
            // For reference:
            // https://github.com/react-native-community/react-native-modal/pull/197
            const shouldSetPanResponder =
              Math.abs(gestureState.dx) >= this.props.panResponderThreshold ||
              Math.abs(gestureState.dy) >= this.props.panResponderThreshold;
            if (shouldSetPanResponder && this.props.onSwipeStart) {
              this.props.onSwipeStart(gestureState);
            }
            this.currentSwipingDirection = this.getSwipingDirection(
              gestureState,
            );
            animEvt = this.createAnimationEventForSwipe();
            return shouldSetPanResponder;
          }
          return false;
        },
        onStartShouldSetPanResponder: (e, gestureState) => {
          const hasScrollableView =
            e._dispatchInstances &&
            e._dispatchInstances.some(instance =>
              /scrollview|flatlist/i.test(instance.type),
            );
          if (
            hasScrollableView &&
            this.shouldPropagateSwipe(e, gestureState) &&
            this.props.scrollTo &&
            this.props.scrollOffset > 0
          ) {
            return false; // user needs to be able to scroll content back up
          }
          if (this.props.onSwipeStart) {
            this.props.onSwipeStart(gestureState);
          }
          // Cleared so that onPanResponderMove can wait to have some delta
          // to work with
          this.currentSwipingDirection = null;
          return true;
        },
        onPanResponderMove: (evt, gestureState) => {
          // Using onStartShouldSetPanResponder we don't have any delta so we don't know
          // The direction to which the user is swiping until some move have been done
          if (!this.currentSwipingDirection) {
            if (gestureState.dx === 0 && gestureState.dy === 0) {
              return;
            }
            this.currentSwipingDirection = this.getSwipingDirection(
              gestureState,
            );
            animEvt = this.createAnimationEventForSwipe();
          }
          if (this.isSwipeDirectionAllowed(gestureState)) {
            // Dim the background while swiping the modal
            const newOpacityFactor =
              1 - this.calcDistancePercentage(gestureState);
            this.backdropRef &&
              this.backdropRef.transitionTo({
                opacity: this.props.backdropOpacity * newOpacityFactor,
              });
            animEvt(evt, gestureState);
            if (this.props.onSwipeMove) {
              this.props.onSwipeMove(newOpacityFactor, gestureState);
            }
          } else {
            if (this.props.scrollTo) {
              if (this.props.scrollHorizontal) {
                let offsetX = -gestureState.dx;
                if (offsetX > this.props.scrollOffsetMax) {
                  offsetX -= (offsetX - this.props.scrollOffsetMax) / 2;
                }
                this.props.scrollTo({x: offsetX, animated: false});
              } else {
                let offsetY = -gestureState.dy;
                if (offsetY > this.props.scrollOffsetMax) {
                  offsetY -= (offsetY - this.props.scrollOffsetMax) / 2;
                }
                this.props.scrollTo({y: offsetY, animated: false});
              }
            }
          }
        },
        onPanResponderRelease: (evt, gestureState) => {
          // Call the onSwipe prop if the threshold has been exceeded on the right direction
          const accDistance = this.getAccDistancePerDirection(gestureState);
          if (
            accDistance > this.props.swipeThreshold &&
            this.isSwipeDirectionAllowed(gestureState)
          ) {
            if (this.props.onSwipeComplete) {
              this.inSwipeClosingState = true;
              this.props.onSwipeComplete(
                {
                  swipingDirection: this.getSwipingDirection(gestureState),
                },
                gestureState,
              );
              return;
            }
            // Deprecated. Remove later.
            if (this.props.onSwipe) {
              this.inSwipeClosingState = true;
              this.props.onSwipe();
              return;
            }
          }
          //Reset backdrop opacity and modal position
          if (this.props.onSwipeCancel) {
            this.props.onSwipeCancel(gestureState);
          }
          if (this.backdropRef) {
            this.backdropRef.transitionTo({
              opacity: this.props.backdropOpacity,
            });
          }
          Animated.spring(this.state.pan, {
            toValue: {x: 0, y: 0},
            bounciness: 0,
            useNativeDriver: false,
          }).start();
          if (this.props.scrollTo) {
            if (this.props.scrollOffset > this.props.scrollOffsetMax) {
              this.props.scrollTo({
                y: this.props.scrollOffsetMax,
                animated: true,
              });
            }
          }
        },
      });
    };
    this.getAccDistancePerDirection = gestureState => {
      switch (this.currentSwipingDirection) {
        case 'up':
          return -gestureState.dy;
        case 'down':
          return gestureState.dy;
        case 'right':
          return gestureState.dx;
        case 'left':
          return -gestureState.dx;
        default:
          return 0;
      }
    };
    this.getSwipingDirection = gestureState => {
      if (Math.abs(gestureState.dx) > Math.abs(gestureState.dy)) {
        return gestureState.dx > 0 ? 'right' : 'left';
      }
      return gestureState.dy > 0 ? 'down' : 'up';
    };
    this.calcDistancePercentage = gestureState => {
      switch (this.currentSwipingDirection) {
        case 'down':
          return (
            (gestureState.moveY - gestureState.y0) /
            ((this.props.deviceHeight || this.state.deviceHeight) -
              gestureState.y0)
          );
        case 'up':
          return reversePercentage(gestureState.moveY / gestureState.y0);
        case 'left':
          return reversePercentage(gestureState.moveX / gestureState.x0);
        case 'right':
          return (
            (gestureState.moveX - gestureState.x0) /
            ((this.props.deviceWidth || this.state.deviceWidth) -
              gestureState.x0)
          );
        default:
          return 0;
      }
    };
    this.createAnimationEventForSwipe = () => {
      if (
        this.currentSwipingDirection === 'right' ||
        this.currentSwipingDirection === 'left'
      ) {
        return Animated.event([null, {dx: this.state.pan.x}], {
          useNativeDriver: false,
        });
      } else {
        return Animated.event([null, {dy: this.state.pan.y}], {
          useNativeDriver: false,
        });
      }
    };
    this.isDirectionIncluded = direction => {
      return Array.isArray(this.props.swipeDirection)
        ? this.props.swipeDirection.includes(direction)
        : this.props.swipeDirection === direction;
    };
    this.isSwipeDirectionAllowed = ({dy, dx}) => {
      const draggedDown = dy > 0;
      const draggedUp = dy < 0;
      const draggedLeft = dx < 0;
      const draggedRight = dx > 0;
      if (
        this.currentSwipingDirection === 'up' &&
        this.isDirectionIncluded('up') &&
        draggedUp
      ) {
        return true;
      } else if (
        this.currentSwipingDirection === 'down' &&
        this.isDirectionIncluded('down') &&
        draggedDown
      ) {
        return true;
      } else if (
        this.currentSwipingDirection === 'right' &&
        this.isDirectionIncluded('right') &&
        draggedRight
      ) {
        return true;
      } else if (
        this.currentSwipingDirection === 'left' &&
        this.isDirectionIncluded('left') &&
        draggedLeft
      ) {
        return true;
      }
      return false;
    };
    this.handleDimensionsUpdate = () => {
      if (!this.props.deviceHeight && !this.props.deviceWidth) {
        // Here we update the device dimensions in the state if the layout changed
        // (triggering a render)
        const deviceWidth = Dimensions.get('window').width;
        const deviceHeight = Dimensions.get('window').height;
        if (
          deviceWidth !== this.state.deviceWidth ||
          deviceHeight !== this.state.deviceHeight
        ) {
          this.setState({deviceWidth, deviceHeight});
        }
      }
    };
    this.open = () => {
      if (this.isTransitioning) {
        return;
      }
      this.isTransitioning = true;
      if (this.backdropRef) {
        this.backdropRef.transitionTo(
          {opacity: this.props.backdropOpacity},
          this.props.backdropTransitionInTiming,
        );
      }
      // This is for resetting the pan position,otherwise the modal gets stuck
      // at the last released position when you try to open it.
      // TODO: Could certainly be improved - no idea for the moment.
      if (this.state.isSwipeable) {
        this.state.pan.setValue({x: 0, y: 0});
      }
      if (this.contentRef) {
        this.props.onModalWillShow && this.props.onModalWillShow();
        if (this.interactionHandle == null) {
          this.interactionHandle = InteractionManager.createInteractionHandle();
        }
        this.contentRef
          .animate(this.animationIn, this.props.animationInTiming)
          .then(() => {
            this.isTransitioning = false;
            if (this.interactionHandle) {
              InteractionManager.clearInteractionHandle(this.interactionHandle);
              this.interactionHandle = null;
            }
            if (!this.props.isVisible) {
              this.close();
            } else {
              this.props.onModalShow();
            }
          });
      }
    };
    this.close = () => {
      if (this.isTransitioning) {
        return;
      }
      this.isTransitioning = true;
      if (this.backdropRef) {
        this.backdropRef.transitionTo(
          {opacity: 0},
          this.props.backdropTransitionOutTiming,
        );
      }
      let animationOut = this.animationOut;
      if (this.inSwipeClosingState) {
        this.inSwipeClosingState = false;
        if (this.currentSwipingDirection === 'up') {
          animationOut = 'slideOutUp';
        } else if (this.currentSwipingDirection === 'down') {
          animationOut = 'slideOutDown';
        } else if (this.currentSwipingDirection === 'right') {
          animationOut = 'slideOutRight';
        } else if (this.currentSwipingDirection === 'left') {
          animationOut = 'slideOutLeft';
        }
      }
      if (this.contentRef) {
        this.props.onModalWillHide && this.props.onModalWillHide();
        if (this.interactionHandle == null) {
          this.interactionHandle = InteractionManager.createInteractionHandle();
        }
        this.contentRef
          .animate(animationOut, this.props.animationOutTiming)
          .then(() => {
            this.isTransitioning = false;
            if (this.interactionHandle) {
              InteractionManager.clearInteractionHandle(this.interactionHandle);
              this.interactionHandle = null;
            }
            if (this.props.isVisible) {
              this.open();
            } else {
              this.setState(
                {
                  showContent: false,
                },
                () => {
                  this.setState(
                    {
                      isVisible: false,
                    },
                    () => {
                      this.props.onModalHide();
                    },
                  );
                },
              );
            }
          });
      }
    };
    this.makeBackdrop = () => {
      if (!this.props.hasBackdrop) {
        return null;
      }
      if (
        this.props.customBackdrop &&
        !React.isValidElement(this.props.customBackdrop)
      ) {
        console.warn(
          'Invalid customBackdrop element passed to Modal. You must provide a valid React element.',
        );
      }
      const {
        customBackdrop,
        backdropColor,
        useNativeDriver,
        useNativeDriverForBackdrop,
        onBackdropPress,
      } = this.props;
      const hasCustomBackdrop = !!this.props.customBackdrop;
      const backdropComputedStyle = [
        {
          width: this.getDeviceWidth(),
          height: this.getDeviceHeight(),
          backgroundColor:
            this.state.showContent && !hasCustomBackdrop
              ? backdropColor
              : 'transparent',
        },
      ];
      const backdropWrapper = React.createElement(
        animatable.View,
        {
          ref: ref => (this.backdropRef = ref),
          useNativeDriver:
            useNativeDriverForBackdrop !== undefined
              ? useNativeDriverForBackdrop
              : useNativeDriver,
          style: [styles.backdrop, backdropComputedStyle],
        },
        hasCustomBackdrop && customBackdrop,
      );
      if (hasCustomBackdrop) {
        // The user will handle backdrop presses himself
        return backdropWrapper;
      }
      // If there's no custom backdrop, handle presses with
      // TouchableWithoutFeedback
      return React.createElement(
        TouchableWithoutFeedback,
        {onPress: onBackdropPress},
        backdropWrapper,
      );
    };
    const {animationIn, animationOut} = buildAnimations(
      extractAnimationFromProps(props),
    );
    this.animationIn = animationIn;
    this.animationOut = animationOut;
    if (this.state.isSwipeable) {
      this.state = {
        ...this.state,
        pan: new Animated.ValueXY(),
      };
      this.buildPanResponder();
    }
    if (props.isVisible) {
      this.state = {
        ...this.state,
        isVisible: true,
        showContent: true,
      };
    }
  }
  static getDerivedStateFromProps(nextProps, state) {
    if (!state.isVisible && nextProps.isVisible) {
      return {isVisible: true, showContent: true};
    }
    return null;
  }
  componentDidMount() {
    // Show deprecation message
    if (this.props.onSwipe) {
      console.warn(
        '`<Modal onSwipe="..." />` is deprecated and will be removed starting from 13.0.0. Use `<Modal onSwipeComplete="..." />` instead.',
      );
    }
    this.didUpdateDimensionsEmitter = DeviceEventEmitter.addListener(
      'didUpdateDimensions',
      this.handleDimensionsUpdate,
    );
    if (this.state.isVisible) {
      this.open();
    }
    this.backHandlerEventSubscription = BackHandler.addEventListener(
      'hardwareBackPress',
      this.onBackButtonPress,
    );
  }
  componentWillUnmount() {
    if (this.backHandlerEventSubscription) {
      this.backHandlerEventSubscription.remove();
    }
    if (this.didUpdateDimensionsEmitter) {
      this.didUpdateDimensionsEmitter.remove();
    }
    if (this.interactionHandle) {
      InteractionManager.clearInteractionHandle(this.interactionHandle);
      this.interactionHandle = null;
    }
  }
  componentDidUpdate(prevProps) {
    // If the animations have been changed then rebuild them to make sure we're
    // using the most up-to-date ones
    if (
      this.props.animationIn !== prevProps.animationIn ||
      this.props.animationOut !== prevProps.animationOut
    ) {
      const {animationIn, animationOut} = buildAnimations(
        extractAnimationFromProps(this.props),
      );
      this.animationIn = animationIn;
      this.animationOut = animationOut;
    }
    // If backdrop opacity has been changed then make sure to update it
    if (
      this.props.backdropOpacity !== prevProps.backdropOpacity &&
      this.backdropRef
    ) {
      this.backdropRef.transitionTo(
        {opacity: this.props.backdropOpacity},
        this.props.backdropTransitionInTiming,
      );
    }
    // On modal open request, we slide the view up and fade in the backdrop
    if (this.props.isVisible && !prevProps.isVisible) {
      this.open();
    } else if (!this.props.isVisible && prevProps.isVisible) {
      // On modal close request, we slide the view down and fade out the backdrop
      this.close();
    }
  }
  render() {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const {
      animationIn,
      animationInTiming,
      animationOut,
      animationOutTiming,
      avoidKeyboard,
      coverScreen,
      hasBackdrop,
      backdropColor,
      backdropOpacity,
      backdropTransitionInTiming,
      backdropTransitionOutTiming,
      customBackdrop,
      children,
      isVisible,
      onModalShow,
      onBackButtonPress,
      useNativeDriver,
      propagateSwipe,
      style,
      ...otherProps
    } = this.props;
    const {testID, ...containerProps} = otherProps;
    const computedStyle = [
      {margin: this.getDeviceWidth() * 0.05, transform: [{translateY: 0}]},
      styles.content,
      style,
    ];
    let panHandlers = {};
    let panPosition = {};
    if (this.state.isSwipeable) {
      panHandlers = {...this.panResponder.panHandlers};
      if (useNativeDriver) {
        panPosition = {
          transform: this.state.pan.getTranslateTransform(),
        };
      } else {
        panPosition = this.state.pan.getLayout();
      }
    }
    // The user might decide not to show the modal while it is animating
    // to enhance performance.
    const _children =
      this.props.hideModalContentWhileAnimating &&
      this.props.useNativeDriver &&
      !this.state.showContent
        ? React.createElement(animatable.View, null)
        : children;
    const containerView = React.createElement(
      animatable.View,
      Object.assign(
        {},
        panHandlers,
        {
          ref: ref => (this.contentRef = ref),
          style: [panPosition, computedStyle],
          pointerEvents: 'box-none',
          useNativeDriver: useNativeDriver,
        },
        containerProps,
      ),
      _children,
    );
    // If coverScreen is set to false by the user
    // we render the modal inside the parent view directly
    if (!coverScreen && this.state.isVisible) {
      return React.createElement(
        View,
        {
          pointerEvents: 'box-none',
          style: [styles.backdrop, styles.containerBox],
        },
        this.makeBackdrop(),
        containerView,
      );
    }
    return React.createElement(
      Modal,
      Object.assign(
        {
          transparent: true,
          animationType: 'none',
          visible: this.state.isVisible,
          onRequestClose: onBackButtonPress,
        },
        otherProps,
      ),
      this.makeBackdrop(),
      avoidKeyboard
        ? React.createElement(
            KeyboardAvoidingView,
            {
              behavior: Platform.OS === 'ios' ? 'padding' : undefined,
              pointerEvents: 'box-none',
              style: computedStyle.concat([{margin: 0}]),
            },
            containerView,
          )
        : containerView,
    );
  }
}
ReactNativeModal.propTypes = {
  animationIn: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
  animationInTiming: PropTypes.number,
  animationOut: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
  animationOutTiming: PropTypes.number,
  avoidKeyboard: PropTypes.bool,
  coverScreen: PropTypes.bool,
  hasBackdrop: PropTypes.bool,
  backdropColor: PropTypes.string,
  backdropOpacity: PropTypes.number,
  backdropTransitionInTiming: PropTypes.number,
  backdropTransitionOutTiming: PropTypes.number,
  customBackdrop: PropTypes.node,
  children: PropTypes.node.isRequired,
  deviceHeight: PropTypes.number,
  deviceWidth: PropTypes.number,
  isVisible: PropTypes.bool.isRequired,
  hideModalContentWhileAnimating: PropTypes.bool,
  propagateSwipe: PropTypes.oneOfType([PropTypes.bool, PropTypes.func]),
  onModalShow: PropTypes.func,
  onModalWillShow: PropTypes.func,
  onModalHide: PropTypes.func,
  onModalWillHide: PropTypes.func,
  onBackButtonPress: PropTypes.func,
  onBackdropPress: PropTypes.func,
  panResponderThreshold: PropTypes.number,
  onSwipeStart: PropTypes.func,
  onSwipeMove: PropTypes.func,
  onSwipeComplete: PropTypes.func,
  onSwipeCancel: PropTypes.func,
  swipeThreshold: PropTypes.number,
  swipeDirection: PropTypes.oneOfType([
    PropTypes.arrayOf(PropTypes.oneOf(['up', 'down', 'left', 'right'])),
    PropTypes.oneOf(['up', 'down', 'left', 'right']),
  ]),
  useNativeDriver: PropTypes.bool,
  useNativeDriverForBackdrop: PropTypes.bool,
  style: PropTypes.any,
  scrollTo: PropTypes.func,
  scrollOffset: PropTypes.number,
  scrollOffsetMax: PropTypes.number,
  scrollHorizontal: PropTypes.bool,
  supportedOrientations: PropTypes.arrayOf(
    PropTypes.oneOf([
      'portrait',
      'portrait-upside-down',
      'landscape',
      'landscape-left',
      'landscape-right',
    ]),
  ),
};
ReactNativeModal.defaultProps = defaultProps;
export default ReactNativeModal;
